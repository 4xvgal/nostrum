export interface RelayPort {
  connect(): Promise<void>
  onEvent(handler: (rawEvent: Uint8Array) => void): void
  publish(event: Uint8Array): Promise<void>
  disconnect(): Promise<void>
  onPublishError?(handler: (eventId: string, reason: string) => void): void
}
