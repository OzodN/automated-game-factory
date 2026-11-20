/** Minimal strongly-typed event emitter. */
export class Emitter<Events extends Record<string, unknown[]>> {
  private readonly handlers = new Map<keyof Events, Set<(...args: any[]) => void>>();

  on<K extends keyof Events>(event: K, fn: (...args: Events[K]) => void): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(fn);
    return () => set!.delete(fn);
  }

  emit<K extends keyof Events>(event: K, ...args: Events[K]): void {
    for (const fn of [...(this.handlers.get(event) ?? [])]) fn(...args);
  }

  clear(): void {
    this.handlers.clear();
  }
}
