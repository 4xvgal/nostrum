export type CorrelationEntry = {
  principal: string
  expiresAt: number
}

export interface StoragePort {
  setIfAbsent(id: string, entry: CorrelationEntry): Promise<boolean>
  set(id: string, entry: CorrelationEntry): Promise<void>
  get(id: string): Promise<CorrelationEntry | null>
  delete(id: string): Promise<void>
  evictExpired(now: number): Promise<void>
}
