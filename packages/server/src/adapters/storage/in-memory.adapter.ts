import type {
  CorrelationEntry,
  StoragePort,
} from '../../ports/storage.port.js'

export class InMemoryStorageAdapter implements StoragePort {
  readonly #store = new Map<string, CorrelationEntry>()

  async setIfAbsent(id: string, entry: CorrelationEntry): Promise<boolean> {
    if (this.#store.has(id)) return false
    this.#store.set(id, entry)
    return true
  }

  async set(id: string, entry: CorrelationEntry): Promise<void> {
    this.#store.set(id, entry)
  }

  async get(id: string): Promise<CorrelationEntry | null> {
    const entry = this.#store.get(id)
    if (!entry) return null
    if (entry.expiresAt > 0 && entry.expiresAt <= nowSeconds()) {
      this.#store.delete(id)
      return null
    }
    return entry
  }

  async delete(id: string): Promise<void> {
    this.#store.delete(id)
  }

  async evictExpired(now: number): Promise<void> {
    for (const [id, entry] of this.#store) {
      if (entry.expiresAt > 0 && entry.expiresAt <= now) {
        this.#store.delete(id)
      }
    }
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}
