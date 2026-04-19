import type NDK from '@nostr-dev-kit/ndk'
import { NDKEvent, type NDKSubscription } from '@nostr-dev-kit/ndk'
import { KINDS_NOSTRUM, type KindSet } from '@nostrum/core'
import type { TransportPort } from '../../ports/transport.port.js'

export class NdkTransportAdapter implements TransportPort {
  #handler: ((bytes: Uint8Array) => void) | null = null
  #sub: NDKSubscription | null = null

  constructor(
    private readonly ndk: NDK,
    private readonly clientPubkey: string,
    private readonly kinds: KindSet = KINDS_NOSTRUM,
  ) {}

  async connect(): Promise<void> {
    await this.ndk.connect()
    this.#sub = this.ndk.subscribe(
      { kinds: [this.kinds.wrap], '#p': [this.clientPubkey] },
      { closeOnEose: false },
    )
    this.#sub.on('event', (evt) => {
      const raw = evt instanceof NDKEvent ? evt.rawEvent() : evt
      const bytes = new TextEncoder().encode(JSON.stringify(raw))
      this.#handler?.(bytes)
    })
  }

  onEvent(handler: (bytes: Uint8Array) => void): void {
    this.#handler = handler
  }

  async publish(bytes: Uint8Array): Promise<void> {
    const json = new TextDecoder().decode(bytes)
    const raw = JSON.parse(json)
    const evt = new NDKEvent(this.ndk, raw)
    await evt.publish()
  }

  async disconnect(): Promise<void> {
    this.#sub?.stop()
    this.#sub = null
    for (const relay of this.ndk.pool.relays.values()) {
      relay.disconnect()
    }
    this.#handler = null
  }
}
