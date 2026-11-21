/**
 * Debounced writes, one at a time per key, where the last value wins: a value is sent once it has
 * settled for `delayMs`, and a newer one waits for the write in flight, so writes never land out of order.
 */
export class CoalescingWriter<V> {
  private readonly latest = new Map<string, V>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly send: (key: string, value: V) => Promise<void>,
    /** Called once nothing is left to write for `key`, with the last write's error if it failed. */
    private readonly settled: (key: string, error?: unknown) => void,
    private readonly delayMs = 600,
  ) {}

  write(key: string, value: V): void {
    this.latest.set(key, value);
    clearTimeout(this.timers.get(key));
    this.timers.set(
      key,
      setTimeout(() => void this.flush(key), this.delayMs),
    );
  }

  /** Whether a value for `key` is waiting or being written. */
  pending(key: string): boolean {
    return this.latest.has(key) || this.inFlight.has(key);
  }

  /** Drops every value not yet sent; a write already in flight still lands. */
  cancel(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.latest.clear();
  }

  private async flush(key: string): Promise<void> {
    this.timers.delete(key);
    const value = this.latest.get(key);
    if (this.inFlight.has(key) || value === undefined) return;
    this.latest.delete(key);
    this.inFlight.add(key);
    let error: unknown;
    try {
      await this.send(key, value);
    } catch (failure) {
      error = failure ?? new Error("write failed");
    }
    this.inFlight.delete(key);
    if (this.latest.has(key)) {
      if (!this.timers.has(key)) void this.flush(key);
    } else {
      this.settled(key, error);
    }
  }
}
