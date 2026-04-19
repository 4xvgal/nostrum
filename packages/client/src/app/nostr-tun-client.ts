import type {
  CryptoPort,
  KindSet,
  NostrRequest,
  NostrResponse,
  ServerInfo,
} from '@nostr-tun/core'
import { KINDS_NIP80, KINDS_NOSTR_TUN } from '@nostr-tun/core'
import type { TransportPort } from '../ports/transport.port.js'
import type { DiscoveryPort } from '../ports/discovery.port.js'

export type NostrTunClientConfig = {
  secretKey: string
  ttl: number
  learnFromAdvertisement?: boolean
  kinds?: KindSet
  strictNostr?: boolean
}

export type NostrTunRequestInit = RequestInit & {
  nostrTunStrict?: boolean
}

type Pending = {
  resolve: (r: Response) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
  url: string
  init: NostrTunRequestInit | undefined
  origin: string
  method: string
  pathname: string
  expiresAt: number
  strict: boolean
  wrapId: string
}

type Manifest = {
  version: string
  pubkey: string
  relays: string[]
  ttl: number
  capabilities: {
    kindSet: 'nostr-tun' | 'nip80' | KindSet
    chunking: boolean
  }
  routes: Array<{
    method: string
    path: string
    kind: 'literal' | 'pattern'
  }>
}

type OriginCacheEntry = {
  pubkey: string
  relays: string[]
  manifest: Manifest | null
  expiresAt: number
  disabledPaths: Set<string>
  notNostrTun?: boolean
}

type ResolveTarget =
  | { kind: 'nostr'; info: ServerInfo }
  | { kind: 'https' }
  | { kind: 'https-and-learn' }

export class NostrTunClient {
  #transport: TransportPort | null = null
  #crypto: CryptoPort | null = null
  #discovery: DiscoveryPort | null = null
  readonly #pinned = new Map<string, ServerInfo>()
  readonly #pending = new Map<string, Pending>()
  readonly #pendingByWrapId = new Map<string, string>()
  readonly #cache = new Map<string, OriginCacheEntry>()
  readonly #manifestFetches = new Map<string, Promise<Manifest | null>>()
  #sweepTimer: ReturnType<typeof setInterval> | null = null
  #connected = false

  constructor(private readonly config: NostrTunClientConfig) {}

  useTransport(adapter: TransportPort): this {
    this.#transport = adapter
    return this
  }

  useCrypto(adapter: CryptoPort): this {
    this.#crypto = adapter
    return this
  }

  useDiscovery(adapter: DiscoveryPort): this {
    this.#discovery = adapter
    return this
  }

  pin(origin: string, info: ServerInfo): this {
    this.#pinned.set(new URL(origin).origin, info)
    return this
  }

  async fetch(
    url: string,
    init?: NostrTunRequestInit,
  ): Promise<Response> {
    if (!this.#transport || !this.#crypto) {
      throw new Error('NostrTunClient: useTransport/useCrypto are required')
    }
    const u = new URL(url)
    const method = (init?.method ?? 'GET').toUpperCase()
    const strict = this.#isStrict(init)
    const target = await this.#resolveTarget(u, method, strict)

    switch (target.kind) {
      case 'nostr':
        return this.#fetchNostr(url, u, method, init, target.info, strict)
      case 'https':
        return globalThis.fetch(url, init)
      case 'https-and-learn':
        return this.#fetchHttpsAndMaybeLearn(url, init)
    }
  }

  #isStrict(init?: NostrTunRequestInit): boolean {
    if (init?.nostrTunStrict === true) return true
    if (init?.nostrTunStrict === false) return false
    return this.config.strictNostr === true
  }

  async disconnect(): Promise<void> {
    if (this.#sweepTimer) {
      clearInterval(this.#sweepTimer)
      this.#sweepTimer = null
    }
    for (const [, p] of this.#pending) {
      clearTimeout(p.timer)
      p.reject(new Error('NostrTunClient disconnected'))
    }
    this.#pending.clear()
    this.#pendingByWrapId.clear()
    await this.#transport?.disconnect()
    this.#connected = false
  }

  async #resolveTarget(
    u: URL,
    method: string,
    strict: boolean,
  ): Promise<ResolveTarget> {
    const pinned = this.#pinned.get(u.origin)
    if (pinned) return { kind: 'nostr', info: pinned }

    const entry = this.#cache.get(u.origin)
    const now = Math.floor(Date.now() / 1000)
    if (entry && entry.expiresAt > now) {
      if (entry.notNostrTun) {
        if (strict) throw strictErr(`origin ${u.origin} is not NostrTun-aware`)
        return { kind: 'https' }
      }
      const pathKey = `${method} ${u.pathname}`
      if (entry.disabledPaths.has(pathKey)) {
        if (strict) throw strictErr(`${pathKey} disabled for Nostr at ${u.origin}`)
        return { kind: 'https' }
      }
      if (entry.manifest && manifestMatches(entry.manifest, method, u.pathname)) {
        if (kindSetCompatible(entry.manifest, this.#configKinds())) {
          return {
            kind: 'nostr',
            info: { pubkey: entry.pubkey, relays: entry.relays },
          }
        }
        entry.disabledPaths.add(pathKey)
        if (strict) throw strictErr(`kindSet mismatch at ${u.origin}`)
        return { kind: 'https' }
      }
      if (entry.manifest) {
        entry.disabledPaths.add(pathKey)
        if (strict)
          throw strictErr(`${pathKey} not in manifest at ${u.origin}`)
        return { kind: 'https' }
      }
    }

    if (this.#discovery) {
      const found = await this.#discovery.resolve(u.origin)
      if (found) {
        const ma = 300
        this.#cache.set(u.origin, {
          pubkey: found.pubkey,
          relays: found.relays,
          manifest: null,
          expiresAt: now + ma,
          disabledPaths: new Set(),
        })
        return { kind: 'nostr', info: found }
      }
    }

    if (strict) {
      throw strictErr(
        `origin ${u.origin} is not pinned and strict mode forbids HTTPS bootstrap`,
      )
    }
    return { kind: 'https-and-learn' }
  }

  async #fetchNostr(
    url: string,
    u: URL,
    method: string,
    init: NostrTunRequestInit | undefined,
    info: ServerInfo,
    strict: boolean,
  ): Promise<Response> {
    await this.#ensureConnected()

    const id = randomCorrelationId()
    const req: NostrRequest = {
      id,
      method,
      path: u.pathname + u.search,
      headers: headersFromInit(init),
      body: await bodyFromInit(init),
      principal: '',
      expiresAt: 0,
    }

    const wrapped = await this.#crypto!.wrap(
      req,
      info.pubkey,
      this.config.secretKey,
      this.config.ttl,
    )
    const wrapId = extractWrapId(wrapped)

    const expiresAt =
      Math.floor(Date.now() / 1000) + this.config.ttl
    const promise = new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        if (wrapId) this.#pendingByWrapId.delete(wrapId)
        const err = new Error(
          `NostrTunClient fetch timeout after ${this.config.ttl}s`,
        )
        err.name = 'TimeoutError'
        reject(err)
      }, this.config.ttl * 1000)
      this.#pending.set(id, {
        resolve,
        reject,
        timer,
        url,
        init,
        origin: u.origin,
        method,
        pathname: u.pathname,
        expiresAt,
        strict,
        wrapId: wrapId ?? '',
      })
      if (wrapId) this.#pendingByWrapId.set(wrapId, id)
    })

    await this.#transport!.publish(wrapped)
    return promise
  }

  async #fetchHttpsAndMaybeLearn(
    url: string,
    init: RequestInit | undefined,
  ): Promise<Response> {
    const res = await globalThis.fetch(url, init)
    if (this.config.learnFromAdvertisement === false) return res
    const now = Math.floor(Date.now() / 1000)
    const origin = new URL(url).origin
    const header = res.headers.get('Nostr-Tun-Location')
    const parsed = header ? parseNostrTunLocation(header) : null
    if (!parsed) {
      this.#cache.set(origin, {
        pubkey: '',
        relays: [],
        manifest: null,
        expiresAt: now + 300,
        disabledPaths: new Set(),
        notNostrTun: true,
      })
      return res
    }
    this.#cache.set(origin, {
      pubkey: parsed.pubkey,
      relays: parsed.relays,
      manifest: null,
      expiresAt: now + (parsed.ma ?? 300),
      disabledPaths: new Set(),
    })
    void this.#fetchManifest(origin)
    return res
  }

  #fetchManifest(origin: string): Promise<Manifest | null> {
    const existing = this.#manifestFetches.get(origin)
    if (existing) return existing
    const p = (async () => {
      try {
        const r = await globalThis.fetch(`${origin}/.well-known/nostr-tun.json`)
        if (!r.ok) return null
        const m = (await r.json()) as Manifest
        const entry = this.#cache.get(origin)
        if (entry) entry.manifest = m
        return m
      } catch {
        return null
      } finally {
        this.#manifestFetches.delete(origin)
      }
    })()
    this.#manifestFetches.set(origin, p)
    return p
  }

  #configKinds(): KindSet {
    return this.config.kinds ?? KINDS_NOSTR_TUN
  }

  async #ensureConnected(): Promise<void> {
    if (this.#connected) return
    this.#transport!.onEvent((bytes) => {
      void this.#onEvent(bytes)
    })
    this.#transport!.onPublishError?.((wrapId, reason) => {
      this.#onPublishError(wrapId, reason)
    })
    await this.#transport!.connect()
    this.#connected = true
    const intervalMs = Math.max(this.config.ttl * 1000, 1000)
    this.#sweepTimer = setInterval(() => this.#sweepPending(), intervalMs)
    ;(this.#sweepTimer as { unref?: () => void }).unref?.()
  }

  #onPublishError(wrapId: string, reason: string): void {
    const reqId = this.#pendingByWrapId.get(wrapId)
    if (!reqId) return
    const p = this.#pending.get(reqId)
    if (!p) return
    clearTimeout(p.timer)
    this.#pending.delete(reqId)
    this.#pendingByWrapId.delete(wrapId)
    const err = new Error(`NostrTunClient publish rejected: ${reason}`)
    err.name = 'PublishRejectedError'
    p.reject(err)
  }

  #sweepPending(): void {
    const now = Math.floor(Date.now() / 1000)
    for (const [id, p] of this.#pending) {
      if (p.expiresAt <= now) {
        clearTimeout(p.timer)
        this.#pending.delete(id)
        if (p.wrapId) this.#pendingByWrapId.delete(p.wrapId)
        const err = new Error(
          'NostrTunClient fetch timeout (pending entry swept)',
        )
        err.name = 'TimeoutError'
        p.reject(err)
      }
    }
  }

  async #onEvent(bytes: Uint8Array): Promise<void> {
    try {
      const res = await this.#crypto!.unwrapResponse(
        bytes,
        this.config.secretKey,
      )
      if (!res) return
      const p = this.#pending.get(res.id)
      if (!p) return

      if (
        res.status === 501 &&
        res.headers['x-nostr-tun-error'] === 'route-not-enabled'
      ) {
        clearTimeout(p.timer)
        this.#pending.delete(res.id)
        if (p.wrapId) this.#pendingByWrapId.delete(p.wrapId)
        const entry = this.#cache.get(p.origin)
        if (entry) entry.disabledPaths.add(`${p.method} ${p.pathname}`)
        if (p.strict) {
          p.reject(
            strictErr(
              `${p.method} ${p.pathname} rejected by server; strict mode forbids HTTPS fallback`,
            ),
          )
          return
        }
        try {
          const retry = await globalThis.fetch(p.url, p.init)
          if (entry) void this.#fetchManifest(p.origin)
          p.resolve(retry)
        } catch (e) {
          p.reject(e instanceof Error ? e : new Error(String(e)))
        }
        return
      }

      clearTimeout(p.timer)
      this.#pending.delete(res.id)
      if (p.wrapId) this.#pendingByWrapId.delete(p.wrapId)
      p.resolve(toWebResponse(res))
    } catch {
      // per-event isolation
    }
  }
}

function extractWrapId(bytes: Uint8Array): string | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as { id?: unknown }).id === 'string'
    ) {
      return (parsed as { id: string }).id
    }
  } catch {}
  return null
}

function randomCorrelationId(): string {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function headersFromInit(init?: RequestInit): Record<string, string> {
  const out: Record<string, string> = {}
  const h = init?.headers
  if (!h) return out
  if (h instanceof Headers) {
    h.forEach((v, k) => {
      out[k] = v
    })
    return out
  }
  if (Array.isArray(h)) {
    for (const [k, v] of h) out[k!] = v!
    return out
  }
  for (const [k, v] of Object.entries(h)) out[k] = v
  return out
}

async function bodyFromInit(init?: RequestInit): Promise<Uint8Array | null> {
  const b = init?.body
  if (b === null || b === undefined) return null
  if (typeof b === 'string') return new TextEncoder().encode(b)
  if (b instanceof Uint8Array) return b
  if (b instanceof ArrayBuffer) return new Uint8Array(b)
  if (ArrayBuffer.isView(b)) {
    return new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
  }
  throw new TypeError(
    'NostrTunClient: unsupported body type; v0 supports string/ArrayBuffer/Uint8Array/null',
  )
}

function toWebResponse(res: NostrResponse): Response {
  return new Response(res.body as BodyInit | null, {
    status: res.status,
    headers: res.headers,
  })
}

function parseNostrTunLocation(
  header: string,
): { pubkey: string; relays: string[]; ma?: number } | null {
  const parts = header.split(';').map((s) => s.trim()).filter(Boolean)
  const map: Record<string, string> = {}
  for (const part of parts) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    map[part.slice(0, eq).trim()] = part.slice(eq + 1).trim()
  }
  const pubkey = map.pubkey
  const relaysRaw = map.relays
  if (!pubkey || !relaysRaw) return null
  const relays = relaysRaw.split(',').map((s) => s.trim()).filter(Boolean)
  if (relays.length === 0) return null
  const maRaw = map.ma
  const ma = maRaw !== undefined ? Number(maRaw) : undefined
  const result: { pubkey: string; relays: string[]; ma?: number } = {
    pubkey,
    relays,
  }
  if (ma !== undefined && Number.isFinite(ma)) result.ma = ma
  return result
}

function manifestMatches(
  manifest: Manifest,
  method: string,
  path: string,
): boolean {
  for (const r of manifest.routes) {
    if (r.method.toUpperCase() !== method) continue
    if (r.kind === 'literal' && r.path === path) return true
    if (r.kind === 'pattern' && matchPath(r.path, path)) return true
  }
  return false
}

function matchPath(pattern: string, path: string): boolean {
  const ps = pattern.split('/')
  const xs = path.split('/')
  if (ps.length !== xs.length) return false
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i]
    if (p === undefined) return false
    if (p.startsWith(':')) continue
    if (p !== xs[i]) return false
  }
  return true
}

function kindSetCompatible(manifest: Manifest, clientKinds: KindSet): boolean {
  const declared = manifest.capabilities.kindSet
  if (declared === 'nostr-tun') return sameKindSet(clientKinds, KINDS_NOSTR_TUN)
  if (declared === 'nip80') return sameKindSet(clientKinds, KINDS_NIP80)
  if (typeof declared === 'object' && declared !== null) {
    return sameKindSet(clientKinds, declared)
  }
  return false
}

function strictErr(message: string): Error {
  const err = new Error(`NostrTunStrictError: ${message}`)
  err.name = 'NostrTunStrictError'
  return err
}

function sameKindSet(a: KindSet, b: KindSet): boolean {
  return (
    a.requestRumor === b.requestRumor &&
    a.responseRumor === b.responseRumor &&
    a.wrap === b.wrap
  )
}
