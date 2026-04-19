import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import * as nip19 from 'nostr-tools/nip19'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'

const SK_KEY = 'btc-alert:auth-sk'
const NOTIFY_PK_KEY = 'btc-alert:notify-pk'

export type Identity = {
  /** Secret key used for NIP-98 signing (and for NIP-04 DM decryption when it matches notify). */
  sk: Uint8Array
  skHex: string
  authPk: string
  authNpub: string
  authNsec: string

  /** Where DMs are delivered. Equal to authPk unless user set a separate notify npub. */
  notifyPk: string
  notifyNpub: string
  /** true when notify is a different pubkey than auth. DMs will NOT be decryptable in this PWA. */
  separateNotify: boolean
}

export function loadOrCreateIdentity(): Identity {
  let skHex = localStorage.getItem(SK_KEY)
  if (!skHex || !/^[0-9a-f]{64}$/.test(skHex)) {
    const sk = generateSecretKey()
    skHex = bytesToHex(sk)
    localStorage.setItem(SK_KEY, skHex)
  }
  const notifyOverride = localStorage.getItem(NOTIFY_PK_KEY)
  return build(skHex, notifyOverride)
}

function build(skHex: string, notifyPkOverride: string | null): Identity {
  const sk = hexToBytes(skHex)
  const authPk = getPublicKey(sk)
  const authNpub = nip19.npubEncode(authPk)
  const authNsec = nip19.nsecEncode(sk)

  const notifyPk =
    notifyPkOverride && /^[0-9a-f]{64}$/.test(notifyPkOverride)
      ? notifyPkOverride
      : authPk
  return {
    sk,
    skHex,
    authPk,
    authNpub,
    authNsec,
    notifyPk,
    notifyNpub: nip19.npubEncode(notifyPk),
    separateNotify: notifyPk !== authPk,
  }
}

/** Import a secret key from hex or `nsec1...`. Clears any notify override so notify == auth. */
export function importSecretKey(raw: string): Identity {
  const trimmed = raw.trim()
  let skHex: string
  if (/^nsec1/.test(trimmed)) {
    const decoded = nip19.decode(trimmed)
    if (decoded.type !== 'nsec') {
      throw new Error(`expected nsec, decoded as ${decoded.type}`)
    }
    skHex = bytesToHex(decoded.data)
  } else if (/^[0-9a-f]{64}$/i.test(trimmed)) {
    skHex = trimmed.toLowerCase()
  } else {
    throw new Error('expected 64-hex or nsec1… format')
  }
  localStorage.setItem(SK_KEY, skHex)
  localStorage.removeItem(NOTIFY_PK_KEY)
  return build(skHex, null)
}

/** Set a notify-only pubkey (DMs go here; NIP-98 keeps using the local auth key). */
export function setNotifyPubkey(raw: string): Identity {
  const trimmed = raw.trim()
  let pkHex: string
  if (/^npub1/.test(trimmed)) {
    const decoded = nip19.decode(trimmed)
    if (decoded.type !== 'npub') {
      throw new Error(`expected npub, decoded as ${decoded.type}`)
    }
    pkHex = decoded.data
  } else if (/^[0-9a-f]{64}$/i.test(trimmed)) {
    pkHex = trimmed.toLowerCase()
  } else {
    throw new Error('expected 64-hex or npub1… format')
  }
  const skHex = localStorage.getItem(SK_KEY)
  if (!skHex) throw new Error('auth key missing; import or reset first')
  localStorage.setItem(NOTIFY_PK_KEY, pkHex)
  return build(skHex, pkHex)
}

/** Clear the notify override so notify == auth again. */
export function clearNotifyOverride(): Identity {
  const skHex = localStorage.getItem(SK_KEY) ?? ''
  localStorage.removeItem(NOTIFY_PK_KEY)
  return build(skHex, null)
}

/** Wipe both keys, regenerate a fresh auth key, notify == auth. */
export function resetIdentity(): Identity {
  localStorage.removeItem(SK_KEY)
  localStorage.removeItem(NOTIFY_PK_KEY)
  return loadOrCreateIdentity()
}
