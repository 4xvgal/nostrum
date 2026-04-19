import type { Handler, Hono, MiddlewareHandler } from 'hono'
import type { CryptoPort, KindSet } from '@nostr-tun/core'
import { KINDS_NIP80, KINDS_NOSTR_TUN } from '@nostr-tun/core'
import type { RelayPort } from '../ports/relay.port.js'
import type { StoragePort } from '../ports/storage.port.js'
import type { HttpPort } from '../ports/http.port.js'
import { CorrelationManager } from '../correlation-manager.js'

export type NostrTunConfig = {
  relays: string[]
  secretKey: string
  ttl: number
  pubkey: string
  kinds?: KindSet
  advertiseTtl?: number
}

type Manifest = {
  version: '0.1'
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

const ROUTE_MARKER = Symbol.for('@nostr-tun/route')

type MarkedMiddleware = MiddlewareHandler & { [ROUTE_MARKER]?: true }

export class NostrTun {
  #relay: RelayPort | null = null
  #crypto: CryptoPort | null = null
  #storage: StoragePort | null = null
  #http: HttpPort | null = null
  #correlation: CorrelationManager | null = null
  #app: Hono | null = null
  #evictionTimer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly config: NostrTunConfig) {}

  useRelay(a: RelayPort): this {
    this.#relay = a
    return this
  }
  useCrypto(a: CryptoPort): this {
    this.#crypto = a
    return this
  }
  useStorage(a: StoragePort): this {
    this.#storage = a
    return this
  }
  useHttp(a: HttpPort): this {
    this.#http = a
    return this
  }

  attachApp(app: Hono): this {
    this.#app = app
    return this
  }

  route(): MiddlewareHandler {
    const mw: MarkedMiddleware = async (c, next) => {
      let fromNostr = false
      try {
        const ctx = c.executionCtx as unknown as
          | { nostrTunDispatch?: boolean }
          | undefined
        fromNostr = ctx?.nostrTunDispatch === true
      } catch {
        // No executionCtx provided — this is plain HTTP.
      }
      if (!fromNostr) {
        try {
          c.req.raw.headers.delete('x-nostr-tun-principal')
        } catch {
          // forbidden-header or locked Headers — best-effort
        }
      }
      await next()
    }
    mw[ROUTE_MARKER] = true
    return mw
  }

  advertise(): MiddlewareHandler {
    const ma = this.config.advertiseTtl ?? 300
    const header = `pubkey=${this.config.pubkey}; relays=${this.config.relays.join(',')}; ma=${ma}`
    return async (c, next) => {
      await next()
      c.header('Nostr-Tun-Location', header)
    }
  }

  manifest(): Handler {
    return (c) => {
      const body = this.#buildManifest()
      const ma = this.config.advertiseTtl ?? 300
      c.header('Cache-Control', `public, max-age=${ma}`)
      c.header('Content-Type', 'application/json')
      return c.body(JSON.stringify(body))
    }
  }

  #buildManifest(): Manifest {
    const kinds = this.config.kinds ?? KINDS_NOSTR_TUN
    const ma = this.config.advertiseTtl ?? 300
    const markedPairs = new Set<string>()
    const app = this.#app
    if (app) {
      for (const r of app.routes) {
        if (!(r.handler as MarkedMiddleware)[ROUTE_MARKER]) continue
        markedPairs.add(`${r.method.toUpperCase()} ${r.path}`)
      }
    }
    const routes: Manifest['routes'] = []
    for (const pair of markedPairs) {
      const [method, path] = splitPair(pair)
      routes.push({
        method,
        path,
        kind: path.includes(':') ? 'pattern' : 'literal',
      })
    }
    return {
      version: '0.1',
      pubkey: this.config.pubkey,
      relays: this.config.relays,
      ttl: ma,
      capabilities: {
        kindSet: serializeKindSet(kinds),
        chunking: false,
      },
      routes,
    }
  }

  async connect(): Promise<void> {
    if (!this.#relay || !this.#crypto || !this.#storage || !this.#http) {
      throw new Error(
        'NostrTun: useRelay/useCrypto/useStorage/useHttp are all required before connect()',
      )
    }
    this.#correlation = new CorrelationManager(this.#storage)
    this.#relay.onEvent((bytes) => {
      void this.#dispatch(bytes)
    })
    await this.#relay.connect()

    const intervalMs = Math.max((this.config.ttl || 30) * 1000, 1000)
    this.#evictionTimer = setInterval(() => {
      void this.#correlation?.evictExpired()
    }, intervalMs)
    ;(this.#evictionTimer as { unref?: () => void }).unref?.()
  }

  async disconnect(): Promise<void> {
    if (this.#evictionTimer) {
      clearInterval(this.#evictionTimer)
      this.#evictionTimer = null
    }
    await this.#relay?.disconnect()
  }

  async #dispatch(bytes: Uint8Array): Promise<void> {
    try {
      const req = await this.#crypto!.unwrapRequest(
        bytes,
        this.config.secretKey,
      )
      if (!req) return

      const fresh = await this.#correlation!.register(req)
      if (!fresh) return

      const webReq = this.#http!.toRequest(req)
      const webRes = this.#isRouteEnabled(req.method, req.path)
        ? await this.#app!.fetch(
            webReq,
            undefined,
            { nostrTunDispatch: true } as never,
          )
        : new Response(null, {
            status: 501,
            headers: { 'x-nostr-tun-error': 'route-not-enabled' },
          })

      const nostrRes = await this.#http!.toNostrResponse(req.id, webRes)
      const entry = await this.#correlation!.resolve(req.id)
      if (!entry) return

      const out = await this.#crypto!.wrap(
        nostrRes,
        entry.principal,
        this.config.secretKey,
        this.config.ttl,
      )
      await this.#relay!.publish(out)
    } catch {
      // Per-event isolation — a single failure must not kill the inbound loop.
    }
  }

  #isRouteEnabled(method: string, path: string): boolean {
    const app = this.#app
    if (!app) return false
    const M = method.toUpperCase()
    for (const r of app.routes) {
      if (r.method.toUpperCase() !== M) continue
      if (!matchPath(r.path, path)) continue
      if ((r.handler as MarkedMiddleware)[ROUTE_MARKER]) return true
    }
    return false
  }
}

function splitPair(s: string): [string, string] {
  const idx = s.indexOf(' ')
  return [s.slice(0, idx), s.slice(idx + 1)]
}

function sameKindSet(a: KindSet, b: KindSet): boolean {
  return (
    a.requestRumor === b.requestRumor &&
    a.responseRumor === b.responseRumor &&
    a.wrap === b.wrap
  )
}

function serializeKindSet(
  kinds: KindSet,
): 'nostr-tun' | 'nip80' | KindSet {
  if (sameKindSet(kinds, KINDS_NOSTR_TUN)) return 'nostr-tun'
  if (sameKindSet(kinds, KINDS_NIP80)) return 'nip80'
  return kinds
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
