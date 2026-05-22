export async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results: R[] = new Array(items.length);
  let cursor = 0;
  let aborted = false;
  const NO_ERROR = Symbol('no-error');
  let firstError: unknown = NO_ERROR;

  async function worker(): Promise<void> {
    while (!aborted) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = await task(items[i], i);
      } catch (err) {
        if (!aborted) {
          aborted = true;
          firstError = err;
        }
        return;
      }
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () =>
    worker(),
  );
  await Promise.all(workers);

  if (firstError !== NO_ERROR) throw firstError;
  return results;
}
