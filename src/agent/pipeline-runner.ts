import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { HuntSource } from './intent.js';

export interface PipelineRequest {
  source: HuntSource;
  /** The child is stopped when it runs longer than this. */
  timeoutMs: number;
}

export interface PipelineResult {
  exitCode: number | null;
  timedOut: boolean;
  /** The last lines the pipeline printed (no secrets: the pipeline never prints any). */
  tail: string[];
}

/** The pipeline runs as its own process, exactly as `npm run dev` does: the Hunter adds no business rule of its own. */
export const HUNT_TIMEOUT_MS = 20 * 60_000;

/**
 * The environment of a hunt: the normal one, with the AI stage switched off and the Gemini key blanked (a hunt never calls a
 * model), and the sources narrowed when the owner asked for one. Nothing else changes: limits, filter, ranking, queue and the
 * daily quota are the pipeline's own.
 */
export function buildPipelineEnv(base: NodeJS.ProcessEnv, source: HuntSource): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, AI_ENABLED: 'false', GEMINI_API_KEY: '' };
  if (source !== 'all') env.SOURCES = source;
  return env;
}

const TOKEN_LIKE = /\b[0-9]{6,}:[A-Za-z0-9_-]{25,}\b/g;
const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const RUNNING_FROM_TS = import.meta.url.endsWith('.ts');

/** How the pipeline is started: from source through tsx during development, from `dist/` once built. */
export const defaultPipelineCommand = (): { file: string; args: string[] } =>
  RUNNING_FROM_TS ? { file: process.execPath, args: ['--import', 'tsx', 'src/index.ts'] } : { file: process.execPath, args: ['dist/index.js'] };

export async function runPipelineChild(
  request: PipelineRequest,
  options: { command?: { file: string; args: string[] }; env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<PipelineResult> {
  const command = options.command ?? defaultPipelineCommand();
  return new Promise((resolve) => {
    const child = spawn(command.file, command.args, {
      cwd: options.cwd ?? PROJECT_ROOT,
      env: buildPipelineEnv(options.env ?? process.env, request.source),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const lines: string[] = [];
    const keep = (chunk: Buffer): void => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (line.trim() === '') continue;
        lines.push(line.replace(TOKEN_LIKE, '[redacted]'));
        if (lines.length > 60) lines.shift();
      }
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    }, request.timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ exitCode: null, timedOut, tail: [...lines, `could not start the pipeline: ${error.message}`] });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, timedOut, tail: lines });
    });
  });
}
