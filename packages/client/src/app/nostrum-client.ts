import type {
  CryptoPort,
  NostrRequest,
  NostrResponse,
  ServerInfo,
} from '@nostrum/core'
import type { TransportPort } from '../ports/transport.port.js'

export type NostrumClientConfig = {
  secretKey: string
  ttl: number
}

type Pending = {
  resolve: (r: Response) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class NostrumClient {
  #transport: TransportPort | null = null
  #crypto: CryptoPort | null = null
  readonly #pinned = new Map<string, ServerInfo>()
  readonly #pending = new Map<string, Pending>()
  #connected = false

  constructor(private readonly config: NostrumClientConfig) {}

  useTransport(adapter: TransportPort): this {
    this.#transport = adapter
    return this
  }

  useCrypto(adapter: CryptoPort): this {
    this.#crypto = adapter
    return this
  }

  pin(origin: string, info: ServerInfo): this {
    this.#pinned.set(new URL(origin).origin, info)
    return this
  }

  async fetch(url: string, init?: RequestInit): Promise<Response> {
    if (!this.#transport || !this.#crypto) {
      throw new Error('NostrumClient: useTransport/useCrypto are required')
    }
    const u = new URL(url)
    const info = this.#pinned.get(u.origin)
    if (!info) {
      throw new Error(`NostrumClient: origin not pinned: ${u.origin}`)
    }

    await this.#ensureConnected()

    const id = randomCorrelationId()
    const req: NostrRequest = {
      id,
      method: (init?.method ?? 'GET').toUpperCase(),
      path: u.pathname + u.search,
      headers: headersFromInit(init),
      body: await bodyFromInit(init),
      principal: '',
      expiresAt: 0,
    }

    const wrapped = await this.#crypto.wrap(
      req,
      info.pubkey,
      this.config.secretKey,
      this.config.ttl,
    )

    const promise = new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        const err = new Error(
          `NostrumClient fetch timeout after ${this.config.ttl}s`,
        )
        err.name = 'TimeoutError'
        reject(err)
      }, this.config.ttl * 1000)
      this.#pending.set(id, { resolve, reject, timer })
    })

    await this.#transport.publish(wrapped)
    return promise
  }

  async disconnect(): Promise<void> {
    for (const [, p] of this.#pending) {
      clearTimeout(p.timer)
      p.reject(new Error('NostrumClient disconnected'))
    }
    this.#pending.clear()
    await this.#transport?.disconnect()
    this.#connected = false
  }

  async #ensureConnected(): Promise<void> {
    if (this.#connected) return
    this.#transport!.onEvent((bytes) => {
      void this.#onEvent(bytes)
    })
    await this.#transport!.connect()
    this.#connected = true
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
      clearTimeout(p.timer)
      this.#pending.delete(res.id)
      p.resolve(toWebResponse(res))
    } catch {
      // per-event isolation
    }
  }
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
    'NostrumClient: unsupported body type; v0 supports string/ArrayBuffer/Uint8Array/null',
  )
}

function toWebResponse(res: NostrResponse): Response {
  return new Response(res.body as BodyInit | null, {
    status: res.status,
    headers: res.headers,
  })
}
