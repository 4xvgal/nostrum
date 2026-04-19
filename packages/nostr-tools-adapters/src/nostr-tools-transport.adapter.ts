import { KINDS_NOSTRUM, type KindSet } from '@nostrum/core'
import type { TransportPort } from '@nostrum/client'
import { WsClient } from './ws-client.js'

export class NostrToolsTransportAdapter implements TransportPort {
  #handler: ((bytes: Uint8Array) => void) | null = null
  #ws: WsClient

  constructor(
    private readonly relayUrl: string,
    private readonly clientPubkey: string,
    private readonly kinds: KindSet = KINDS_NOSTRUM,
  ) {
    this.#ws = new WsClient(this.relayUrl)
  }

  async connect(): Promise<void> {
    await this.#ws.connect()
    this.#ws.subscribe(
      { kinds: [this.kinds.wrap], '#p': [this.clientPubkey] },
      (bytes) => this.#handler?.(bytes),
    )
  }

  onEvent(handler: (bytes: Uint8Array) => void): void {
    this.#handler = handler
  }

  onPublishError(handler: (eventId: string, reason: string) => void): void {
    this.#ws.onPublishError(handler)
  }

  async publish(bytes: Uint8Array): Promise<void> {
    const json = new TextDecoder().decode(bytes)
    this.#ws.publish(json)
  }

  async disconnect(): Promise<void> {
    await this.#ws.disconnect()
    this.#handler = null
  }
}
