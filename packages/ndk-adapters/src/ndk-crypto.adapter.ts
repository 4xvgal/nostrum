import NDK, { NDKEvent, NDKPrivateKeySigner } from '@nostr-dev-kit/ndk'
import type { NDKSigner, NDKUser } from '@nostr-dev-kit/ndk'
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

export class NdkCryptoAdapter implements CryptoPort {
  constructor(
    private readonly ndk: NDK,
    private readonly kinds: KindSet = KINDS_NOSTRUM,
  ) {}

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

    const callerSigner = new NDKPrivateKeySigner(callerSecretKey, this.ndk)
    const callerPubkey = callerSigner.pubkey
    const recipient = this.ndk.getUser({ pubkey: recipientPubkey })

    const now = Math.floor(Date.now() / 1000)

    const rumor = {
      kind: innerKind,
      pubkey: callerPubkey,
      created_at: now,
      tags: [] as string[][],
      content: JSON.stringify(contentObj),
    }

    const sealContent = await callerSigner.encrypt(
      recipient,
      JSON.stringify(rumor),
      'nip44',
    )
    const seal = new NDKEvent(this.ndk, {
      kind: SEAL_KIND,
      pubkey: callerPubkey,
      created_at: randomPastTimestamp(now),
      tags: [],
      content: sealContent,
    })
    await seal.sign(callerSigner)

    const ephemeral = NDKPrivateKeySigner.generate()
    const ephemeralUser = this.ndk.getUser({ pubkey: ephemeral.pubkey })
    void ephemeralUser

    const wrapContent = await ephemeral.encrypt(
      recipient,
      JSON.stringify(seal.rawEvent()),
      'nip44',
    )

    const wrapTags: string[][] = [['p', recipientPubkey]]
    if (this.kinds.wrap !== EPHEMERAL_WRAP_KIND) {
      wrapTags.push(['expiration', String(now + ttl)])
    }

    const wrap = new NDKEvent(this.ndk, {
      kind: this.kinds.wrap,
      pubkey: ephemeral.pubkey,
      created_at: randomPastTimestamp(now),
      tags: wrapTags,
      content: wrapContent,
    })
    await wrap.sign(ephemeral)

    const json = JSON.stringify(wrap.rawEvent())
    return new TextEncoder().encode(json)
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
      const parsed = JSON.parse(json)
      const wrap = new NDKEvent(this.ndk, parsed)
      if (wrap.kind !== this.kinds.wrap) return null

      const callerSigner = new NDKPrivateKeySigner(callerSecretKey, this.ndk)
      const wrapAuthor = this.ndk.getUser({ pubkey: wrap.pubkey })
      const sealJson = await decryptAs(
        callerSigner,
        wrapAuthor,
        wrap.content,
      )
      if (sealJson === null) return null

      const sealRaw = JSON.parse(sealJson)
      if (sealRaw?.kind !== SEAL_KIND) return null
      const sealAuthor = this.ndk.getUser({ pubkey: sealRaw.pubkey })

      const rumorJson = await decryptAs(
        callerSigner,
        sealAuthor,
        sealRaw.content,
      )
      if (rumorJson === null) return null

      const rumorRaw = JSON.parse(rumorJson)
      if (
        typeof rumorRaw?.kind !== 'number' ||
        typeof rumorRaw?.pubkey !== 'string' ||
        typeof rumorRaw?.content !== 'string'
      ) {
        return null
      }

      if (rumorRaw.pubkey !== sealRaw.pubkey) return null

      return {
        kind: rumorRaw.kind,
        pubkey: rumorRaw.pubkey,
        content: rumorRaw.content,
        expiresAt: readExpirationTag(wrap.tags),
      }
    } catch {
      return null
    }
  }
}

async function decryptAs(
  signer: NDKSigner,
  sender: NDKUser,
  cipherText: string,
): Promise<string | null> {
  try {
    return await signer.decrypt(sender, cipherText, 'nip44')
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
