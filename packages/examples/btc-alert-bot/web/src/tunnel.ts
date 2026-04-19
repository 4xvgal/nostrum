import { NostrTunClient } from '@nostr-tun/client'
import {
  NostrToolsCryptoAdapter,
  NostrToolsTransportAdapter,
  NostrServiceDiscoveryAdapter,
} from '@nostr-tun/nostr-tools-adapters'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { bytesToHex } from '@noble/hashes/utils'

const DEFAULT_BOOTSTRAP =
  'wss://relay.damus.io,wss://nos.lol,wss://relay.nostr.band'

function parseRelayList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('ws://') || s.startsWith('wss://'))
}

const SERVER_PUBKEY = (import.meta.env.VITE_SERVER_PUBKEY ?? '').toLowerCase()
const BOOTSTRAP = parseRelayList(
  import.meta.env.VITE_BOOTSTRAP_RELAYS ?? DEFAULT_BOOTSTRAP,
)

export const config = {
  serverPubkey: SERVER_PUBKEY,
  bootstrapRelays: BOOTSTRAP,
  // Populated after discovery resolves — used for DM subscription.
  resolvedRelays: [] as string[],
}

export function originForPubkey(pk: string): string {
  return `nostr://${pk}`
}

export function url(path: string): string {
  return originForPubkey(config.serverPubkey) + path
}

/**
 * Build a connected client. Runs discovery up-front on the bootstrap
 * relays to learn the server's listening relay, then points the transport
 * there. The resolved ServerInfo is also pinned to skip discovery on
 * subsequent fetches.
 */
export async function buildClient(): Promise<NostrTunClient> {
  if (!/^[0-9a-f]{64}$/.test(config.serverPubkey)) {
    throw new Error(
      'Missing / malformed VITE_SERVER_PUBKEY — expected 64-char hex.',
    )
  }
  if (config.bootstrapRelays.length === 0) {
    throw new Error(
      'VITE_BOOTSTRAP_RELAYS is empty — at least one public relay URL is required.',
    )
  }

  const discovery = new NostrServiceDiscoveryAdapter({
    bootstrapRelays: config.bootstrapRelays,
  })
  const origin = originForPubkey(config.serverPubkey)
  const info = await discovery.resolve(origin)
  if (!info || info.relays.length === 0) {
    throw new Error(
      `Could not discover server ${config.serverPubkey.slice(0, 12)}… on bootstrap relays.\n` +
        `Ensure the bot has published its kind-31910 announcement to at least one of: ${config.bootstrapRelays.join(', ')}`,
    )
  }
  config.resolvedRelays = info.relays

  const ephemeralSkBytes = generateSecretKey()
  const ephemeralSk = bytesToHex(ephemeralSkBytes)
  const ephemeralPk = getPublicKey(ephemeralSkBytes)

  const client = new NostrTunClient({
    secretKey: ephemeralSk,
    ttl: 30,
    strictNostr: true,
  })
    .useTransport(
      new NostrToolsTransportAdapter(info.relays[0]!, ephemeralPk),
    )
    .useCrypto(new NostrToolsCryptoAdapter())
    .useDiscovery(discovery)
    .pin(origin, info)
  return client
}
