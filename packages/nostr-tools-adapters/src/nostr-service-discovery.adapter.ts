import { Relay } from 'nostr-tools/relay'
import type { Event } from 'nostr-tools/core'
import { verifyEvent } from 'nostr-tools/pure'
import {
  KIND_SERVICE_ANNOUNCEMENT,
  type ServerInfo,
} from '@nostr-tun/core'
import type { DiscoveryPort } from '@nostr-tun/client'

export type NostrServiceDiscoveryConfig = {
  /** Public relays to query for kind-31910 announcements. */
  bootstrapRelays: string[]
  /** Per-relay query timeout. Default 4000ms. */
  timeoutMs?: number
}

function parseRelaysFromTags(tags: string[][]): string[] {
  const out: string[] = []
  for (const t of tags) {
    if (t[0] === 'relay' && typeof t[1] === 'string') out.push(t[1])
  }
  return out
}

/**
 * Resolve ServerInfo for a `nostr://<hex>` origin by fan-querying a small
 * set of bootstrap relays for the most-recent kind-31910 announcement
 * authored by `<hex>`. The first valid announcement wins.
 *
 * Ignores origins with other schemes (returns null) so this adapter can
 * be chained with origin-based adapters (NIP-05, DNS TXT).
 */
export class NostrServiceDiscoveryAdapter implements DiscoveryPort {
  readonly #bootstrap: string[]
  readonly #timeoutMs: number

  constructor(config: NostrServiceDiscoveryConfig) {
    if (config.bootstrapRelays.length === 0) {
      throw new Error(
        'NostrServiceDiscoveryAdapter: at least one bootstrap relay is required',
      )
    }
    this.#bootstrap = [...config.bootstrapRelays]
    this.#timeoutMs = config.timeoutMs ?? 4000
  }

  async resolve(origin: string): Promise<ServerInfo | null> {
    const pubkey = extractHexPubkey(origin)
    if (!pubkey) return null

    const events = await Promise.all(
      this.#bootstrap.map((url) => this.#queryRelay(url, pubkey)),
    )
    const candidates = events.filter((e): e is Event => e !== null)
    if (candidates.length === 0) return null
    candidates.sort((a, b) => b.created_at - a.created_at)
    const best = candidates[0]!
    const relays = parseRelaysFromTags(best.tags)
    if (relays.length === 0) return null
    return { pubkey, relays }
  }

  async #queryRelay(url: string, pubkey: string): Promise<Event | null> {
    return new Promise<Event | null>((resolve) => {
      let settled = false
      let newest: Event | null = null
      const settle = (v: Event | null): void => {
        if (settled) return
        settled = true
        resolve(v)
      }
      const timer = setTimeout(() => settle(newest), this.#timeoutMs)
      void (async () => {
        let relay: Relay | null = null
        try {
          relay = await Relay.connect(url)
          const sub = relay.subscribe(
            [{ kinds: [KIND_SERVICE_ANNOUNCEMENT], authors: [pubkey] }],
            {
              onevent(e) {
                if (!verifyEvent(e)) return
                if (!newest || e.created_at > newest.created_at) newest = e
              },
              oneose() {
                clearTimeout(timer)
                try {
                  sub.close()
                } catch {}
                try {
                  relay?.close()
                } catch {}
                settle(newest)
              },
            },
          )
        } catch {
          clearTimeout(timer)
          try {
            relay?.close()
          } catch {}
          settle(null)
        }
      })()
    })
  }
}

function extractHexPubkey(origin: string): string | null {
  // Accept `nostr://<hex>` (origin key form: "nostr://<host>")
  const m = /^nostr:\/\/([0-9a-f]{64})$/i.exec(origin)
  return m ? m[1]!.toLowerCase() : null
}
