/** Minimal strongly-typed event emitter (avoids stringly-typed node:events across our APIs). */
export class Emitter<Events extends Record<string, unknown>> {
  private readonly listeners = new Map<keyof Events, Set<(payload: never) => void>>();

  on<K extends keyof Events>(event: K, listener: (payload: Events[K]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    for (const l of this.listeners.get(event) ?? []) {
      try {
        (l as (p: Events[K]) => void)(payload);
      } catch {
        // A faulty listener must never break the emitter's caller.
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
