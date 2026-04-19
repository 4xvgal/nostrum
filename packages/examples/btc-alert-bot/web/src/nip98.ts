import { finalizeEvent } from 'nostr-tools/pure'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'

/**
 * Build `Authorization: Nostr <base64>` value per NIP-98.
 * For requests with a body, include payload sha256 in tags.
 */
export function buildNip98Header(args: {
  sk: Uint8Array
  method: string
  url: string
  body?: string
}): string {
  const tags: string[][] = [
    ['u', args.url],
    ['method', args.method.toUpperCase()],
  ]
  if (args.body && args.body.length > 0) {
    tags.push([
      'payload',
      bytesToHex(sha256(new TextEncoder().encode(args.body))),
    ])
  }
  const event = finalizeEvent(
    {
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: '',
    },
    args.sk,
  )
  const b64 = btoa(JSON.stringify(event))
  return `Nostr ${b64}`
}
