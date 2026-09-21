import type { MatchAnalysis } from '../domain/match-analysis.js';
import type { AnalysisInput, AnalyzerStats, OpportunityAnalyzer } from './analyzer.js';
import { assembleAnalysis, parseModelOutput } from './analysis-output.js';
import {
  AnalysisInvalidOutputError,
  AnalysisQuotaError,
  AnalysisRejectedError,
  AnalysisUnavailableError,
} from './errors.js';
import { buildPrompt } from './prompt.js';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export interface GeminiOptions {
  timeoutMs: number;
  /** Minimum gap between two HTTP calls; keeps a free-tier key under its per-minute limit. */
  minIntervalMs: number;
  /** Pause before the single retry of a transient failure. */
  retryDelayMs: number;
  /** Injectable for tests; defaults to the global fetch. */
  fetch: typeof fetch;
}

const DEFAULT_OPTIONS: GeminiOptions = {
  timeoutMs: 60_000,
  minIntervalMs: 6_500,
  retryDelayMs: 4_000,
  fetch: (...args) => fetch(...args),
};

const TRANSIENT_STATUSES = new Set([408, 500, 502, 503, 504]);

/**
 * Gemini through plain HTTP. One model, one request per attempt, no fallback to any other model
 * or provider, no grounding or tools. The API key travels in a header (never in a URL) and is
 * scrubbed from every error message.
 *
 * Errors: 429 -> AnalysisQuotaError (never retried); 400/401/403/404 -> AnalysisRejectedError;
 * timeouts, network failures and 5xx -> one retry, then AnalysisUnavailableError; unusable
 * answers -> AnalysisInvalidOutputError.
 */
export class GeminiAnalyzer implements OpportunityAnalyzer {
  readonly id = 'gemini';
  readonly model: string;
  readonly stats: AnalyzerStats = { requests: 0, lastStatus: null };

  private readonly apiKey: string;
  private readonly options: GeminiOptions;
  private lastCallAt = 0;

  constructor(apiKey: string, model: string, options: Partial<GeminiOptions> = {}) {
    this.apiKey = apiKey;
    this.model = model;
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  async analyze(input: AnalysisInput): Promise<MatchAnalysis> {
    const prompt = buildPrompt(input.opportunity, input.candidate);
    const { text, modelVersion } = await this.generateWithOneRetry(prompt.system, prompt.user);

    return assembleAnalysis(parseModelOutput(text), {
      opportunity: input.opportunity,
      candidate: input.candidate,
      provider: this.id,
      model: this.model,
      modelVersion,
      now: input.now ?? new Date(),
    });
  }

  private async generateWithOneRetry(system: string, user: string): Promise<{ text: string; modelVersion: string | null }> {
    try {
      return await this.generateOnce(system, user);
    } catch (error) {
      if (!(error instanceof AnalysisUnavailableError)) throw error;
      await new Promise((resolve) => setTimeout(resolve, this.options.retryDelayMs));
      return this.generateOnce(system, user);
    }
  }

  private async generateOnce(system: string, user: string): Promise<{ text: string; modelVersion: string | null }> {
    await this.throttle();
    this.stats.requests += 1;
    this.stats.lastStatus = null;

    let response: Response;
    try {
      response = await this.options.fetch(`${API_BASE}/models/${encodeURIComponent(this.model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 4096, responseMimeType: 'application/json' },
        }),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new AnalysisUnavailableError(`Gemini request timed out after ${this.options.timeoutMs}ms.`);
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new AnalysisUnavailableError(`Gemini request failed: ${this.scrub(reason)}`);
    }

    this.stats.lastStatus = response.status;
    const body: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      const detail = this.describeError(body);
      if (response.status === 429) {
        throw new AnalysisQuotaError(`Gemini quota or rate limit reached (HTTP 429)${detail}.`);
      }
      if (TRANSIENT_STATUSES.has(response.status)) {
        throw new AnalysisUnavailableError(`Gemini is temporarily unavailable (HTTP ${response.status})${detail}.`);
      }
      throw new AnalysisRejectedError(`Gemini rejected the request (HTTP ${response.status})${detail}.`);
    }

    return this.extract(body);
  }

  private extract(body: unknown): { text: string; modelVersion: string | null } {
    const record = asRecord(body);
    const blockReason = asRecord(record?.promptFeedback)?.blockReason;
    if (typeof blockReason === 'string') {
      throw new AnalysisInvalidOutputError(`Gemini blocked the prompt (${blockReason}).`);
    }

    const candidate = asRecord(Array.isArray(record?.candidates) ? record.candidates[0] : null);
    const finishReason = candidate?.finishReason;
    if (typeof finishReason === 'string' && finishReason !== 'STOP') {
      throw new AnalysisInvalidOutputError(`Gemini stopped before completing the answer (${finishReason}).`);
    }

    const parts = asRecord(candidate?.content)?.parts;
    const text = Array.isArray(parts)
      ? parts.map((part) => (typeof asRecord(part)?.text === 'string' ? String(asRecord(part)?.text) : '')).join('')
      : '';
    if (text.trim() === '') {
      throw new AnalysisInvalidOutputError('Gemini returned no text.');
    }
    return { text, modelVersion: typeof record?.modelVersion === 'string' ? record.modelVersion : null };
  }

  private describeError(body: unknown): string {
    const message = asRecord(asRecord(body)?.error)?.message;
    return typeof message === 'string' ? `: ${this.scrub(message).slice(0, 300).replace(/[.\s]+$/, '')}` : '';
  }

  private async throttle(): Promise<void> {
    const wait = this.lastCallAt + this.options.minIntervalMs - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.lastCallAt = Date.now();
  }

  /** Removes the key, and anything shaped like a Google API key, from text that may be shown or stored. */
  private scrub(text: string): string {
    return text.split(this.apiKey).join('[redacted]').replace(/AIza[0-9A-Za-z_-]{20,}/g, '[redacted]');
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
