import { finalizeEvent } from 'nostr-tools/pure'
import { Relay } from 'nostr-tools/relay'
import {
  KIND_SERVICE_ANNOUNCEMENT,
  type ServiceAnnouncementContent,
} from '@nostr-tun/core'

export type PublishServiceAnnouncementArgs = {
  /** Server hex secret key. */
  secretKey: string
  /** Origin the service is exposed under (becomes the `d` tag). */
  origin: string
  /** Relay URLs the server is reachable on for nostr-tun traffic. */
  relays: string[]
  /** Service manifest body. */
  content: ServiceAnnouncementContent
  /** Public bootstrap relays to publish the announcement to. */
  bootstrapRelays: string[]
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

/**
 * Sign + publish a kind-31910 service announcement to each bootstrap relay.
 * Fire-and-forget semantics — per-relay failures are swallowed so one bad
 * bootstrap does not break the announcement fan-out.
 */
export async function publishServiceAnnouncement(
  args: PublishServiceAnnouncementArgs,
): Promise<void> {
  const tags: string[][] = [
    ['d', args.origin],
    ...args.relays.map((r) => ['relay', r]),
    ['alt', 'nostr-tun service manifest'],
  ]
  const event = finalizeEvent(
    {
      kind: KIND_SERVICE_ANNOUNCEMENT,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: JSON.stringify(args.content),
    },
    hexToBytes(args.secretKey),
  )
  await Promise.all(
    args.bootstrapRelays.map(async (url) => {
      try {
        const relay = await withTimeout(Relay.connect(url), 6000)
        await withTimeout(relay.publish(event), 6000)
        relay.close()
      } catch (e) {
        console.warn(
          '[announce] relay failed',
          url,
          e instanceof Error ? e.message : String(e),
        )
      }
    }),
  )
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e as Error)
      },
    )
  })
}
