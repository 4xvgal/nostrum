import { finalizeEvent } from 'nostr-tools/pure'
import * as nip04 from 'nostr-tools/nip04'
import { Relay } from 'nostr-tools/relay'
import { env } from './env.js'

let relay: Relay | null = null

async function getRelay(): Promise<Relay> {
  if (relay && relay.connected) return relay
  relay = await Relay.connect(env.relayUrl)
  return relay
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

/**
 * Send a plain NIP-04 DM (kind 4) from the bot to `recipientPk`.
 * Kept intentionally simple for the example; production should use NIP-17
 * sealed/gift-wrapped DMs.
 */
export async function sendDm(
  recipientPk: string,
  plaintext: string,
): Promise<void> {
  const skBytes = hexToBytes(env.secretKey)
  const ciphertext = await nip04.encrypt(skBytes, recipientPk, plaintext)
  const event = finalizeEvent(
    {
      kind: 4,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', recipientPk]],
      content: ciphertext,
    },
    skBytes,
  )
  const r = await getRelay()
  await r.publish(event)
}
