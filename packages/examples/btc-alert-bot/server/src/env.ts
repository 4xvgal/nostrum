import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { bytesToHex } from '@noble/hashes/utils'

function readOrGenerateKey(): { sk: string; pk: string } {
  const hex = process.env.BOT_SECRET_KEY
  if (hex && /^[0-9a-f]{64}$/i.test(hex)) {
    const sk = hex.toLowerCase()
    return { sk, pk: getPublicKey(hexToBytes(sk)) }
  }
  const skBytes = generateSecretKey()
  const sk = bytesToHex(skBytes)
  return { sk, pk: getPublicKey(skBytes) }
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

const keys = readOrGenerateKey()

const DEFAULT_BOOTSTRAP =
  'wss://relay.damus.io,wss://nos.lol,wss://relay.nostr.band'

function parseRelayList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('ws://') || s.startsWith('wss://'))
}

export const env = {
  relayUrl: process.env.RELAY_URL ?? 'wss://nostr.vulpem.com',
  bootstrapRelays: parseRelayList(
    process.env.BOOTSTRAP_RELAYS ?? DEFAULT_BOOTSTRAP,
  ),
  httpPort: Number(process.env.HTTP_PORT ?? 3100),
  secretKey: keys.sk,
  pubkey: keys.pk,
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 60_000),
  priceSourceUrl:
    process.env.PRICE_SOURCE_URL ??
    'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true',
}
