import {
  finalizeEvent,
  generateSecretKey,
  getEventHash,
  getPublicKey,
  verifyEvent,
} from 'nostr-tools/pure'
import { v2 as nip44 } from 'nostr-tools/nip44'
import {
  KINDS_NOSTRUM,
  type CryptoPort,
  type KindSet,
  type NostrRequest,
  type NostrResponse,
} from '@nostrum/core'
import { decodeBody, encodeBody } from './body-codec.js'

const SEAL_KIND = 13
const EPHEMERAL_WRAP_KIND = 21059

type RumorContent = {
  id: string
  method?: string
  path?: string
  status?: number
  headers?: Record<string, string>
  body?: string | null
  bodyEncoding?: string | null
}

type Rumor = {
  id: string
  kind: number
  pubkey: string
  created_at: number
  tags: string[][]
  content: string
}

export class NostrToolsCryptoAdapter implements CryptoPort {
  constructor(private readonly kinds: KindSet = KINDS_NOSTRUM) {}

  async wrap(
    payload: NostrRequest | NostrResponse,
    recipientPubkey: string,
    callerSecretKey: string,
    ttl: number,
  ): Promise<Uint8Array> {
    const isResponse = 'status' in payload
    const innerKind = isResponse
      ? this.kinds.responseRumor
      : this.kinds.requestRumor

    const { body, bodyEncoding } = encodeBody(payload.body)
    const contentObj: RumorContent = isResponse
      ? {
          id: payload.id,
          status: payload.status,
          headers: payload.headers,
          body,
          bodyEncoding,
        }
      : {
          id: payload.id,
          method: payload.method,
          path: payload.path,
          headers: payload.headers,
          body,
          bodyEncoding,
        }

    const callerSk = hexToBytes(callerSecretKey)
    const callerPubkey = getPublicKey(callerSk)

    const now = Math.floor(Date.now() / 1000)

    // Rumor — unsigned event, id derived from content
    const rumorBase = {
      kind: innerKind,
      pubkey: callerPubkey,
      created_at: now,
      tags: [] as string[][],
      content: JSON.stringify(contentObj),
    }
    const rumor: Rumor = {
      id: getEventHash(rumorBase),
      ...rumorBase,
    }

    // Seal — kind 13, signed by caller, encrypted to recipient
    const callerRecipientKey = nip44.utils.getConversationKey(
      callerSk,
      recipientPubkey,
    )
    const sealContent = nip44.encrypt(JSON.stringify(rumor), callerRecipientKey)
    const seal = finalizeEvent(
      {
        kind: SEAL_KIND,
        created_at: randomPastTimestamp(now),
        tags: [],
        content: sealContent,
      },
      callerSk,
    )

    // Wrap — kind 1059/21059, signed by ephemeral, encrypted to recipient
    const ephemeralSk = generateSecretKey()
    const ephemeralRecipientKey = nip44.utils.getConversationKey(
      ephemeralSk,
      recipientPubkey,
    )
    const wrapContent = nip44.encrypt(JSON.stringify(seal), ephemeralRecipientKey)

    const wrapTags: string[][] = [['p', recipientPubkey]]
    if (this.kinds.wrap !== EPHEMERAL_WRAP_KIND) {
      wrapTags.push(['expiration', String(now + ttl)])
    }

    const wrap = finalizeEvent(
      {
        kind: this.kinds.wrap,
        created_at: randomPastTimestamp(now),
        tags: wrapTags,
        content: wrapContent,
      },
      ephemeralSk,
    )

    return new TextEncoder().encode(JSON.stringify(wrap))
  }

  async unwrapRequest(
    wrappedBytes: Uint8Array,
    callerSecretKey: string,
  ): Promise<NostrRequest | null> {
    const rumor = await this.#openRumor(wrappedBytes, callerSecretKey)
    if (!rumor) return null
    if (rumor.kind !== this.kinds.requestRumor) return null

    let content: RumorContent
    try {
      content = JSON.parse(rumor.content) as RumorContent
    } catch {
      return null
    }

    if (
      typeof content.id !== 'string' ||
      typeof content.method !== 'string' ||
      typeof content.path !== 'string'
    ) {
      return null
    }

    return {
      id: content.id,
      method: content.method,
      path: content.path,
      headers: content.headers ?? {},
      body: decodeBody(content.body, content.bodyEncoding),
      principal: rumor.pubkey,
      expiresAt: rumor.expiresAt,
    }
  }

  async unwrapResponse(
    wrappedBytes: Uint8Array,
    callerSecretKey: string,
  ): Promise<NostrResponse | null> {
    const rumor = await this.#openRumor(wrappedBytes, callerSecretKey)
    if (!rumor) return null
    if (rumor.kind !== this.kinds.responseRumor) return null

    let content: RumorContent
    try {
      content = JSON.parse(rumor.content) as RumorContent
    } catch {
      return null
    }

    if (typeof content.id !== 'string' || typeof content.status !== 'number') {
      return null
    }

    return {
      id: content.id,
      status: content.status,
      headers: content.headers ?? {},
      body: decodeBody(content.body, content.bodyEncoding),
    }
  }

  async #openRumor(
    wrappedBytes: Uint8Array,
    callerSecretKey: string,
  ): Promise<{
    kind: number
    pubkey: string
    content: string
    expiresAt: number
  } | null> {
    try {
      const json = new TextDecoder().decode(wrappedBytes)
      const wrap = JSON.parse(json)
      if (!wrap || typeof wrap !== 'object') return null
      if (wrap.kind !== this.kinds.wrap) return null
      if (typeof wrap.pubkey !== 'string' || typeof wrap.content !== 'string') {
        return null
      }
      if (!verifyEvent(wrap)) return null

      const callerSk = hexToBytes(callerSecretKey)

      const wrapKey = nip44.utils.getConversationKey(callerSk, wrap.pubkey)
      const sealJson = tryDecrypt(wrap.content, wrapKey)
      if (sealJson === null) return null

      let sealRaw: unknown
      try {
        sealRaw = JSON.parse(sealJson)
      } catch {
        return null
      }
      if (
        !sealRaw ||
        typeof sealRaw !== 'object' ||
        (sealRaw as { kind?: unknown }).kind !== SEAL_KIND ||
        typeof (sealRaw as { pubkey?: unknown }).pubkey !== 'string' ||
        typeof (sealRaw as { content?: unknown }).content !== 'string'
      ) {
        return null
      }
      const seal = sealRaw as {
        kind: number
        pubkey: string
        content: string
      }
      if (!verifyEvent(sealRaw as Parameters<typeof verifyEvent>[0])) return null

      const sealKey = nip44.utils.getConversationKey(callerSk, seal.pubkey)
      const rumorJson = tryDecrypt(seal.content, sealKey)
      if (rumorJson === null) return null

      let rumorRaw: unknown
      try {
        rumorRaw = JSON.parse(rumorJson)
      } catch {
        return null
      }
      if (
        !rumorRaw ||
        typeof rumorRaw !== 'object' ||
        typeof (rumorRaw as { kind?: unknown }).kind !== 'number' ||
        typeof (rumorRaw as { pubkey?: unknown }).pubkey !== 'string' ||
        typeof (rumorRaw as { content?: unknown }).content !== 'string'
      ) {
        return null
      }
      const rumor = rumorRaw as { kind: number; pubkey: string; content: string }

      // Seal author must equal rumor author (NIP-59 guarantee)
      if (rumor.pubkey !== seal.pubkey) return null

      const tags = Array.isArray(wrap.tags) ? (wrap.tags as string[][]) : []

      return {
        kind: rumor.kind,
        pubkey: rumor.pubkey,
        content: rumor.content,
        expiresAt: readExpirationTag(tags),
      }
    } catch {
      return null
    }
  }
}

function tryDecrypt(payload: string, key: Uint8Array): string | null {
  try {
    return nip44.decrypt(payload, key)
  } catch {
    return null
  }
}

function readExpirationTag(tags: string[][]): number {
  for (const tag of tags) {
    if (tag[0] === 'expiration') {
      const n = Number(tag[1])
      if (Number.isFinite(n)) return n
    }
  }
  return 0
}

function randomPastTimestamp(now: number): number {
  const twoDays = 2 * 24 * 60 * 60
  return now - Math.floor(Math.random() * twoDays)
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  if (clean.length % 2 !== 0) throw new Error('invalid hex length')
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}
