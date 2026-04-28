/**
 * Run async work for each item with at most `limit` concurrent executions.
 * Results appear in the same order as `items`.
 */
export async function runWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const safeLimit = Math.max(1, Math.floor(limit));
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(safeLimit, items.length);

  async function worker(): Promise<void> {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
