import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'

const SK_KEY = 'btc-alert:notify-sk'

export type Keys = { sk: Uint8Array; skHex: string; pk: string }

export function loadOrCreateKeys(): Keys {
  const existing = localStorage.getItem(SK_KEY)
  if (existing && /^[0-9a-f]{64}$/.test(existing)) {
    const sk = hexToBytes(existing)
    return { sk, skHex: existing, pk: getPublicKey(sk) }
  }
  const sk = generateSecretKey()
  const skHex = bytesToHex(sk)
  localStorage.setItem(SK_KEY, skHex)
  return { sk, skHex, pk: getPublicKey(sk) }
}

export function resetKeys(): Keys {
  localStorage.removeItem(SK_KEY)
  return loadOrCreateKeys()
}
