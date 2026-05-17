// Generic retry helper for transient HTTP failures.
//
// Wraps any async function. Retries on:
//   - HTTP 5xx responses (500, 502, 503, 504)
//   - Network errors (ECONNRESET, ETIMEDOUT, EAI_AGAIN, etc.)
//   - fetch() TypeError on network failure
// Does NOT retry on:
//   - HTTP 4xx (including 404, 401, 403, 429) — deterministic, not transient
//   - Programming errors (TypeError from bad code, ReferenceError, etc.)
//
// Budget: 3 total attempts, ~10s wall-time cap (1s + 2s + 4s = 7s of waits
// max, plus actual request time).
//
// Backoff: exponential with 50% jitter.
//   attempt 1 failed -> wait 1.0–1.5s
//   attempt 2 failed -> wait 2.0–3.0s
//   attempt 3 failed -> give up, throw
//
// Logging: each retry attempt is logged to stderr with the label provided by
// the caller. Successful first-attempts are silent.

export type RetryOptions = {
  // Human-readable label for log lines (e.g. "codeberg:forgejo/forgejo /pulls?page=10").
  label: string;
  // Override the default 3 attempts if needed (mostly for tests).
  maxAttempts?: number;
  // Override the default 1000ms base delay if needed (mostly for tests).
  baseDelayMs?: number;
};

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 1000;

// Network error codes that indicate a transient failure worth retrying.
// node:undici (the fetch impl in Node 18+) surfaces these as the `code`
// property on the thrown error, sometimes nested under `.cause`.
const RETRIABLE_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN', // DNS temporary failure
  'ENETUNREACH',
  'EPIPE',
  'UND_ERR_SOCKET', // undici socket error
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

// HTTP 5xx status codes worth retrying. We don't retry 501 (Not Implemented)
// because that's deterministic, not transient.
const RETRIABLE_HTTP_STATUSES = new Set([500, 502, 503, 504]);

// Errors thrown by Octokit carry .status; errors thrown by our own fetch
// wrappers carry the status code in the message ("HTTP 504 on ..."). We
// accept both shapes.
function extractHttpStatus(err: unknown): number | null {
  if (err == null || typeof err !== 'object') return null;
  // Octokit shape
  const status = (err as { status?: unknown }).status;
  if (typeof status === 'number' && status >= 100 && status < 600) {
    return status;
  }
  // Our forgejo.ts / gitlab.ts wrappers throw Error with "HTTP NNN on ..."
  const msg = (err as { message?: unknown }).message;
  if (typeof msg === 'string') {
    const m = msg.match(/^HTTP (\d{3})\b/);
    if (m) return Number(m[1]);
  }
  return null;
}

function extractNetworkCode(err: unknown): string | null {
  if (err == null || typeof err !== 'object') return null;
  // Direct .code
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string') return code;
  // Sometimes wrapped under .cause (undici nests its errors)
  const cause = (err as { cause?: unknown }).cause;
  if (cause != null && typeof cause === 'object') {
    const innerCode = (cause as { code?: unknown }).code;
    if (typeof innerCode === 'string') return innerCode;
  }
  return null;
}

export function isRetriable(err: unknown): boolean {
  const status = extractHttpStatus(err);
  if (status !== null) {
    return RETRIABLE_HTTP_STATUSES.has(status);
  }
  const code = extractNetworkCode(err);
  if (code !== null) {
    return RETRIABLE_NETWORK_CODES.has(code);
  }
  // fetch() throws a plain TypeError on network failure with no .code. We
  // treat any TypeError thrown from fetch as retriable. To avoid retrying
  // unrelated TypeErrors (programming bugs), we match on the message text.
  if (err instanceof TypeError) {
    const msg = err.message.toLowerCase();
    if (msg.includes('fetch failed') || msg.includes('network')) {
      return true;
    }
  }
  return false;
}

function summarizeError(err: unknown): string {
  const status = extractHttpStatus(err);
  if (status !== null) return `HTTP ${status}`;
  const code = extractNetworkCode(err);
  if (code !== null) return code;
  if (err instanceof Error) return err.name;
  return 'unknown error';
}

// Calculates the delay before the *next* attempt, given the attempt number
// that just failed. Returns delay in ms with 50% jitter applied.
//
//   failed attempt 1 -> wait ~1.0–1.5s before attempt 2
//   failed attempt 2 -> wait ~2.0–3.0s before attempt 3
export function delayForAttempt(failedAttempt: number, baseDelayMs: number): number {
  const base = baseDelayMs * Math.pow(2, failedAttempt - 1);
  // 50% jitter: result is in [base, base * 1.5]
  return Math.floor(base * (1 + Math.random() * 0.5));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function retryable<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetriable(err) || attempt === maxAttempts) {
        throw err;
      }
      const waitMs = delayForAttempt(attempt, baseDelayMs);
      const summary = summarizeError(err);
      console.warn(
        `  retry ${opts.label}: attempt ${attempt} failed (${summary}), waiting ${(waitMs / 1000).toFixed(1)}s before attempt ${attempt + 1}/${maxAttempts}`,
      );
      await sleep(waitMs);
    }
  }
  // Unreachable but keeps TS happy: the loop either returns or throws.
  throw lastErr;
}
