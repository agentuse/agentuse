/**
 * Map over items with at most `limit` calls to `fn` in flight, preserving
 * input order in the result. Rejects on the first `fn` rejection.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Counting semaphore for bounding concurrent fs access across recursive
 * walks, where per-call mapLimit would still multiply across levels.
 */
export class Semaphore {
  private waiters: (() => void)[] = [];
  private available: number;

  constructor(permits: number) {
    this.available = permits;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.available > 0) {
      this.available--;
    } else {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    try {
      return await fn();
    } finally {
      const waiter = this.waiters.shift();
      if (waiter) waiter();
      else this.available++;
    }
  }
}
