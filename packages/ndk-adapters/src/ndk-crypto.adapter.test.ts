import { beforeAll, describe, expect, test } from 'bun:test'
import NDK, { NDKPrivateKeySigner } from '@nostr-dev-kit/ndk'
import {
  KINDS_NIP80,
  KINDS_NOSTRUM,
  type KindSet,
  type NostrRequest,
  type NostrResponse,
} from '@nostrum/core'
import { NdkCryptoAdapter } from './ndk-crypto.adapter.js'

const BODY_TEXT = '{"a":1}'

function makeRequest(overrides: Partial<NostrRequest> = {}): NostrRequest {
  return {
    id: 'a'.repeat(32),
    method: 'POST',
    path: '/v1/x',
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(BODY_TEXT),
    principal: '',
    expiresAt: 0,
    ...overrides,
  }
}

function makeResponse(overrides: Partial<NostrResponse> = {}): NostrResponse {
  return {
    id: 'a'.repeat(32),
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(BODY_TEXT),
    ...overrides,
  }
}

for (const kinds of [KINDS_NOSTRUM, KINDS_NIP80] satisfies KindSet[]) {
  describe(`NdkCryptoAdapter (wrap=${kinds.wrap})`, () => {
    const ndk = new NDK()
    ndk.explicitRelayUrls = []
    const adapter = new NdkCryptoAdapter(ndk, kinds)

    let clientSk: string
    let clientPk: string
    let serverSk: string
    let serverPk: string

    beforeAll(() => {
      const client = NDKPrivateKeySigner.generate()
      const server = NDKPrivateKeySigner.generate()
      clientSk = client.privateKey
      clientPk = client.pubkey
      serverSk = server.privateKey
      serverPk = server.pubkey
    })

    test('request round-trip preserves fields, principal, and tags', async () => {
      const req = makeRequest()
      const bytes = await adapter.wrap(req, serverPk, clientSk, 60)
      const got = await adapter.unwrapRequest(bytes, serverSk)

      expect(got).not.toBeNull()
      expect(got!.id).toBe(req.id)
      expect(got!.method).toBe('POST')
      expect(got!.path).toBe('/v1/x')
      expect(got!.headers['content-type']).toBe('application/json')
      expect(new TextDecoder().decode(got!.body!)).toBe(BODY_TEXT)
      expect(got!.principal).toBe(clientPk)

      const raw = JSON.parse(new TextDecoder().decode(bytes))
      expect(raw.kind).toBe(kinds.wrap)
      const hasExp = (raw.tags as string[][]).some((t) => t[0] === 'expiration')
      if (kinds.wrap === 21059) {
        expect(hasExp).toBe(false)
        expect(got!.expiresAt).toBe(0)
      } else {
        expect(hasExp).toBe(true)
        expect(got!.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000))
      }
    })

    test('response round-trip preserves fields', async () => {
      const res = makeResponse()
      const bytes = await adapter.wrap(res, clientPk, serverSk, 60)
      const got = await adapter.unwrapResponse(bytes, clientSk)

      expect(got).not.toBeNull()
      expect(got!.id).toBe(res.id)
      expect(got!.status).toBe(200)
      expect(new TextDecoder().decode(got!.body!)).toBe(BODY_TEXT)
    })

    test('wrong inner kind returns null (request bytes fed to unwrapResponse)', async () => {
      const bytes = await adapter.wrap(makeRequest(), serverPk, clientSk, 60)
      expect(await adapter.unwrapResponse(bytes, serverSk)).toBeNull()
    })

    test('wrong inner kind returns null (response bytes fed to unwrapRequest)', async () => {
      const bytes = await adapter.wrap(makeResponse(), clientPk, serverSk, 60)
      expect(await adapter.unwrapRequest(bytes, clientSk)).toBeNull()
    })

    test('wrong outer kind returns null', async () => {
      const bytes = await adapter.wrap(makeRequest(), serverPk, clientSk, 60)
      const parsed = JSON.parse(new TextDecoder().decode(bytes))
      parsed.kind = kinds.wrap + 1
      const bogus = new TextEncoder().encode(JSON.stringify(parsed))
      expect(await adapter.unwrapRequest(bogus, serverSk)).toBeNull()
    })

    test('bad secret key returns null', async () => {
      const wrongSk = NDKPrivateKeySigner.generate().privateKey
      const bytes = await adapter.wrap(makeRequest(), serverPk, clientSk, 60)
      expect(await adapter.unwrapRequest(bytes, wrongSk)).toBeNull()
    })

    test('binary body round-trips via base64', async () => {
      const binary = new Uint8Array([0xff, 0xfe, 0x00, 0x01, 0x80, 0x7f])
      const bytes = await adapter.wrap(
        makeRequest({ body: binary }),
        serverPk,
        clientSk,
        60,
      )
      const got = await adapter.unwrapRequest(bytes, serverSk)
      expect(got).not.toBeNull()
      expect(Array.from(got!.body!)).toEqual(Array.from(binary))
    })

    test('null body round-trips', async () => {
      const bytes = await adapter.wrap(
        makeRequest({
          body: null,
          method: 'GET',
          headers: {},
        }),
        serverPk,
        clientSk,
        60,
      )
      const got = await adapter.unwrapRequest(bytes, serverSk)
      expect(got).not.toBeNull()
      expect(got!.body).toBeNull()
    })
  })
}
