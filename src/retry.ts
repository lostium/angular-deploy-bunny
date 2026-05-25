export interface RetryOptions {
  /** Number of additional attempts after the first (0 = a single attempt). */
  retries: number;
  /** Base backoff in ms; the wait grows exponentially. Defaults to 300. */
  baseDelayMs?: number;
  /** Called before each retry with the error and the 1-based attempt number. */
  onRetry?: (err: unknown, attempt: number) => void;
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const retries = Math.max(0, Math.floor(opts.retries));
  const baseDelayMs = opts.baseDelayMs ?? 300;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries) throw err;
      attempt += 1;
      opts.onRetry?.(err, attempt);
      // Exponential backoff with jitter (50–100% of the computed delay).
      const backoff = baseDelayMs * 2 ** (attempt - 1);
      await sleep(backoff * (0.5 + Math.random() * 0.5));
    }
  }
}
