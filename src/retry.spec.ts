import { describe, expect, it, vi } from 'vitest';
import { withRetry } from './retry.js';

describe('withRetry', () => {
  it('returns the result without retrying when fn succeeds', async () => {
    const fn = vi.fn(async () => 'ok');
    const out = await withRetry(fn, { retries: 3, baseDelayMs: 0 });
    expect(out).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries until fn succeeds', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new Error('transient');
      return 'ok';
    });
    const out = await withRetry(fn, { retries: 3, baseDelayMs: 0 });
    expect(out).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('rethrows the last error after exhausting retries', async () => {
    const fn = vi.fn(async () => {
      throw new Error('boom');
    });
    await expect(withRetry(fn, { retries: 2, baseDelayMs: 0 })).rejects.toThrow('boom');
    expect(fn).toHaveBeenCalledTimes(3); // initial attempt + 2 retries
  });

  it('does not retry when retries is 0', async () => {
    const fn = vi.fn(async () => {
      throw new Error('boom');
    });
    await expect(withRetry(fn, { retries: 0, baseDelayMs: 0 })).rejects.toThrow('boom');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('calls onRetry with the error and the 1-based attempt number', async () => {
    const onRetry = vi.fn();
    let calls = 0;
    const fn = async () => {
      calls += 1;
      if (calls < 2) throw new Error('x');
      return 1;
    };
    await withRetry(fn, { retries: 3, baseDelayMs: 0, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(expect.any(Error), 1);
  });
});
