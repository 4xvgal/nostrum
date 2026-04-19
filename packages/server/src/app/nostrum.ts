import type { Hono, MiddlewareHandler } from 'hono'
import type { CryptoPort } from '@nostrum/core'
import type { RelayPort } from '../ports/relay.port.js'
import type { StoragePort } from '../ports/storage.port.js'
import type { HttpPort } from '../ports/http.port.js'
import { CorrelationManager } from '../correlation-manager.js'

export type NostrumConfig = {
  relays: string[]
  secretKey: string
  ttl: number
}

const ROUTE_MARKER = Symbol.for('@nostrum/route')

type MarkedMiddleware = MiddlewareHandler & { [ROUTE_MARKER]?: true }

export class Nostrum {
  #relay: RelayPort | null = null
  #crypto: CryptoPort | null = null
  #storage: StoragePort | null = null
  #http: HttpPort | null = null
  #correlation: CorrelationManager | null = null
  #app: Hono | null = null

  constructor(private readonly config: NostrumConfig) {}

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
    const mw: MarkedMiddleware = async (_c, next) => {
      await next()
    }
    mw[ROUTE_MARKER] = true
    return mw
  }

  async connect(): Promise<void> {
    if (!this.#relay || !this.#crypto || !this.#storage || !this.#http) {
      throw new Error(
        'Nostrum: useRelay/useCrypto/useStorage/useHttp are all required before connect()',
      )
    }
    this.#correlation = new CorrelationManager(this.#storage)
    this.#relay.onEvent((bytes) => {
      void this.#dispatch(bytes)
    })
    await this.#relay.connect()
  }

  async disconnect(): Promise<void> {
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
        ? await this.#app!.fetch(webReq)
        : new Response(null, {
            status: 501,
            headers: { 'x-nostrum-error': 'route-not-enabled' },
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
