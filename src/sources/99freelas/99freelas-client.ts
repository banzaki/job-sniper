import { SourceBlockedError, SourceResponseError } from '../source-errors.js';

export const BASE_URL = 'https://www.99freelas.com.br';

const USER_AGENT = 'JobSniper/0.1 (personal opportunity monitor)';
const ACCEPT = 'text/html,application/xhtml+xml';

const CHALLENGE_TITLE =
  /just a moment|attention required|access denied|checking your browser|are you (a )?human|verificando seu navegador/i;
const CHALLENGE_MARKERS =
  /cf-browser-verification|cf-challenge-running|g-recaptcha|h-captcha|hcaptcha\.com\/1\/api/i;

export interface HtmlFetcher {
  fetchHtml(url: string): Promise<string>;
}

export interface ClientOptions {
  timeoutMs: number;
  /** Minimum gap between two requests; requests are expected to be sequential. */
  minIntervalMs: number;
}

const DEFAULT_OPTIONS: ClientOptions = { timeoutMs: 15_000, minIntervalMs: 1_500 };

export class Freelas99Client implements HtmlFetcher {
  private readonly options: ClientOptions;
  private lastRequestAt = 0;

  constructor(options: Partial<ClientOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  async fetchHtml(url: string): Promise<string> {
    await this.throttle();

    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: ACCEPT,
          'Accept-Language': 'pt-BR,pt;q=0.9',
        },
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new SourceResponseError(`Request timed out after ${this.options.timeoutMs}ms: ${url}`);
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new SourceResponseError(`Network error requesting ${url}: ${reason}`);
    }

    if (response.status === 403 || response.status === 429) {
      throw new SourceBlockedError(
        `HTTP ${response.status} from ${url}. Access is being refused; stopping without retry.`,
      );
    }
    if (response.headers.get('cf-mitigated')) {
      throw new SourceBlockedError(`Bot-protection challenge detected for ${url}; stopping.`);
    }
    if (!response.ok) {
      throw new SourceResponseError(`Unexpected HTTP ${response.status} from ${url}.`);
    }
    if (new URL(response.url).origin !== BASE_URL) {
      throw new SourceResponseError(`Unexpected redirect to ${response.url} while requesting ${url}.`);
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().includes('text/html')) {
      throw new SourceResponseError(`Expected HTML from ${url} but received "${contentType}".`);
    }

    const html = await response.text();
    assertNotChallenged(html, url);
    return html;
  }

  private async throttle(): Promise<void> {
    const wait = this.lastRequestAt + this.options.minIntervalMs - Date.now();
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    this.lastRequestAt = Date.now();
  }
}

function assertNotChallenged(html: string, url: string): void {
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] ?? '';
  if (CHALLENGE_TITLE.test(title) || CHALLENGE_MARKERS.test(html)) {
    throw new SourceBlockedError(`CAPTCHA or bot-protection page detected for ${url}; stopping.`);
  }
}
