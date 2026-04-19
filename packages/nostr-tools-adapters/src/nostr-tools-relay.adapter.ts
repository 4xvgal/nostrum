import { KINDS_NOSTRUM, type KindSet } from '@nostrum/core'
import type { RelayPort } from '@nostrum/server'
import { WsClient } from './ws-client.js'

export class NostrToolsRelayAdapter implements RelayPort {
  #handler: ((bytes: Uint8Array) => void) | null = null
  #ws: WsClient

  constructor(
    private readonly relayUrl: string,
    private readonly serverPubkey: string,
    private readonly kinds: KindSet = KINDS_NOSTRUM,
  ) {
    this.#ws = new WsClient(this.relayUrl)
  }

  async connect(): Promise<void> {
    await this.#ws.connect()
    this.#ws.subscribe(
      { kinds: [this.kinds.wrap], '#p': [this.serverPubkey] },
      (bytes) => this.#handler?.(bytes),
    )
  }

  onEvent(handler: (bytes: Uint8Array) => void): void {
    this.#handler = handler
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
