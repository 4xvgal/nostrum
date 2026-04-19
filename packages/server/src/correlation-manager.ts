import type { NostrRequest } from '@nostrum/core'
import type {
  CorrelationEntry,
  StoragePort,
} from './ports/storage.port.js'

export class CorrelationManager {
  constructor(private readonly storage: StoragePort) {}

  async register(req: NostrRequest): Promise<boolean> {
    return this.storage.setIfAbsent(req.id, {
      principal: req.principal,
      expiresAt: req.expiresAt,
    })
  }

  async resolve(id: string): Promise<CorrelationEntry | null> {
    return this.storage.get(id)
  }

  async evictExpired(): Promise<void> {
    await this.storage.evictExpired(Math.floor(Date.now() / 1000))
  }
}
