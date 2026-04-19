import { Relay } from 'nostr-tools/relay'
import * as nip04 from 'nostr-tools/nip04'
import { config } from './tunnel.js'

export type IncomingDm = {
  id: string
  from: string
  createdAt: number
  text: string
}

/**
 * Subscribe to kind-4 DMs sent to `recipientPk` and authored by `config.serverPubkey`.
 * Returns an unsubscribe function. Decryption uses NIP-04.
 */
export async function subscribeDms(args: {
  recipientSk: Uint8Array
  recipientPk: string
  onDm: (dm: IncomingDm) => void
  onError?: (e: unknown) => void
}): Promise<() => void> {
  const relayUrl = config.resolvedRelays[0]
  if (!relayUrl) {
    throw new Error('subscribeDms called before tunnel discovery resolved')
  }
  const relay = await Relay.connect(relayUrl)
  const since = Math.floor(Date.now() / 1000) - 24 * 3600
  const sub = relay.subscribe(
    [
      {
        kinds: [4],
        authors: [config.serverPubkey],
        '#p': [args.recipientPk],
        since,
      },
    ],
    {
      onevent: async (event) => {
        try {
          const text = await nip04.decrypt(
            args.recipientSk,
            event.pubkey,
            event.content,
          )
          args.onDm({
            id: event.id,
            from: event.pubkey,
            createdAt: event.created_at,
            text,
          })
        } catch (e) {
          args.onError?.(e)
        }
      },
    },
  )
  return () => {
    try {
      sub.close()
    } catch {}
    try {
      relay.close()
    } catch {}
  }
}
