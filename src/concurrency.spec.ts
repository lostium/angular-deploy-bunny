import { describe, expect, it } from 'vitest';
import { runWithConcurrency } from './concurrency.js';

describe('runWithConcurrency', () => {
  it('runs all tasks and returns their results in order', async () => {
    const results = await runWithConcurrency(
      [1, 2, 3, 4, 5],
      2,
      async (n) => n * 10,
    );
    expect(results).toEqual([10, 20, 30, 40, 50]);
  });

  it('respects the concurrency cap', async () => {
    let inFlight = 0;
    let peak = 0;
    await runWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    });
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('rejects with the first error and stops dispatching new tasks', async () => {
    let started = 0;
    await expect(
      runWithConcurrency([1, 2, 3, 4, 5], 1, async (n) => {
        started++;
        if (n === 2) throw new Error('boom');
        await new Promise((r) => setTimeout(r, 1));
        return n;
      }),
    ).rejects.toThrow(/boom/);
    expect(started).toBeLessThanOrEqual(2);
  });
});
