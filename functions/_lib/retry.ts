/**
 * Retry with exponential backoff and full jitter.
 *
 * Jitter matters more than it looks: when a provider returns 429 to a burst of
 * runs, a fixed backoff makes every one of them retry at the same instant and
 * the burst simply repeats.
 */
import { log } from './log';

export interface RetryOptions {
  attempts: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  onAttempt?: (attempt: number, error: unknown) => Promise<void> | void;
}

export function isRetryable(error: unknown): boolean {
  if (error && typeof error === 'object' && 'retryable' in error) {
    return Boolean((error as { retryable: unknown }).retryable);
  }
  return false;
}

export function statusIsRetryable(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  const attempts = Math.max(1, options.attempts);
  const base = options.baseDelayMs ?? 500;
  const max = options.maxDelayMs ?? 8_000;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      await options.onAttempt?.(attempt, error);

      const canRetry = attempt < attempts && isRetryable(error);
      if (!canRetry) break;

      const ceiling = Math.min(max, base * 2 ** (attempt - 1));
      const delay = Math.floor(Math.random() * ceiling);
      log.warn('Retrying after failure', { attempt, delayMs: delay, error: String(error) });
      await sleep(delay);
    }
  }

  throw lastError;
}
