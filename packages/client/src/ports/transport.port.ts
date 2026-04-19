export interface TransportPort {
  connect(): Promise<void>
  onEvent(handler: (rawEvent: Uint8Array) => void): void
  publish(event: Uint8Array): Promise<void>
  disconnect(): Promise<void>
}
