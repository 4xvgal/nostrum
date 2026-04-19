import { KINDS_NOSTR_TUN, type KindSet } from '@nostr-tun/core'
import type { RelayPort } from '@nostr-tun/server'
import { WsClient } from './ws-client.js'

export class NostrToolsRelayAdapter implements RelayPort {
  #handler: ((bytes: Uint8Array) => void) | null = null
  #ws: WsClient

  constructor(
    private readonly relayUrl: string,
    private readonly serverPubkey: string,
    private readonly kinds: KindSet = KINDS_NOSTR_TUN,
  ) {
    this.#ws = new WsClient(this.relayUrl)
  }

  async connect(): Promise<void> {
    await this.#ws.connect()
    this.#ws.subscribe(
      { kinds: [this.kinds.wrap], '#p': [this.serverPubkey] },
      (bytes) => this.#handler?.(bytes),
    )
    // Server has no pending to cancel on publish reject — log for visibility.
    this.#ws.onPublishError((id, reason) => {
      console.warn(`[relay-publish-reject] ${id}: ${reason}`)
    })
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
