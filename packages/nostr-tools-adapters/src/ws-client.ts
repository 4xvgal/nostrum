export type RelayFilter = {
  kinds: number[]
  '#p': string[]
}

type EventHandler = (bytes: Uint8Array) => void
type PublishErrorHandler = (eventId: string, reason: string) => void

const ACK_TTL_MS = 60_000

export class WsClient {
  #ws: WebSocket | null = null
  #url: string
  #subId: string
  #filter: RelayFilter | null = null
  #handler: EventHandler | null = null
  #publishErrorHandler: PublishErrorHandler | null = null
  #pendingAck = new Map<string, number>()
  #connectPromise: Promise<void> | null = null
  #closed = false

  constructor(url: string) {
    this.#url = url
    this.#subId = 'nostrum-' + Math.random().toString(36).slice(2, 10)
  }

  async connect(): Promise<void> {
    if (this.#connectPromise) return this.#connectPromise
    if (this.#ws && this.#ws.readyState === WebSocket.OPEN) return

    this.#connectPromise = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.#url)
      this.#ws = ws
      ws.onopen = () => {
        if (this.#filter) this.#sendReq()
        resolve()
      }
      ws.onerror = (err) => {
        reject(new Error(`WebSocket error: ${String(err)}`))
      }
      ws.onmessage = (ev) => this.#onMessage(ev.data)
      ws.onclose = () => {
        if (!this.#closed && this.#handler) {
          // bench-time failure is loud — do not silently reconnect
          console.warn(`[ws-client] ${this.#url} closed unexpectedly`)
        }
      }
    })
    return this.#connectPromise
  }

  subscribe(filter: RelayFilter, handler: EventHandler): void {
    this.#filter = filter
    this.#handler = handler
    if (this.#ws && this.#ws.readyState === WebSocket.OPEN) this.#sendReq()
  }

  onPublishError(handler: PublishErrorHandler): void {
    this.#publishErrorHandler = handler
  }

  publish(eventJson: string): void {
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) {
      throw new Error('ws not open; call connect() first')
    }
    const id = extractEventId(eventJson)
    if (id) {
      this.#pendingAck.set(id, Date.now() + ACK_TTL_MS)
      this.#sweepOneExpired()
    }
    this.#ws.send(`["EVENT",${eventJson}]`)
  }

  async disconnect(): Promise<void> {
    this.#closed = true
    this.#pendingAck.clear()
    this.#publishErrorHandler = null
    if (!this.#ws) return
    try {
      if (this.#ws.readyState === WebSocket.OPEN) {
        this.#ws.send(`["CLOSE","${this.#subId}"]`)
      }
      this.#ws.close()
    } catch {}
    this.#ws = null
    this.#handler = null
    this.#connectPromise = null
  }

  #sendReq(): void {
    if (!this.#ws || !this.#filter) return
    const frame = JSON.stringify(['REQ', this.#subId, this.#filter])
    this.#ws.send(frame)
  }

  #sweepOneExpired(): void {
    const now = Date.now()
    // best-effort O(1) cleanup — drop at most one expired entry per insert
    const first = this.#pendingAck.entries().next()
    if (first.done) return
    const [id, expiresAt] = first.value
    if (expiresAt <= now) this.#pendingAck.delete(id)
  }

  #onMessage(data: unknown): void {
    if (typeof data !== 'string') return
    let msg: unknown
    try {
      msg = JSON.parse(data)
    } catch {
      return
    }
    if (!Array.isArray(msg) || typeof msg[0] !== 'string') return
    // ["EVENT", subId, event] — the only frame we care about for dispatch
    if (msg[0] === 'EVENT' && msg[1] === this.#subId && msg[2]) {
      const eventJson = JSON.stringify(msg[2])
      // Synchronous dispatch — no queue, no coalescing (P1 contract)
      this.#handler?.(new TextEncoder().encode(eventJson))
      return
    }
    // ["OK", eventId, ok, msg] — async publish result (P1C control path)
    if (msg[0] === 'OK' && typeof msg[1] === 'string') {
      const id = msg[1]
      if (!this.#pendingAck.delete(id)) return
      if (msg[2] === false) {
        const reason = typeof msg[3] === 'string' ? msg[3] : ''
        this.#publishErrorHandler?.(id, reason)
      }
      return
    }
    // EOSE / NOTICE ignored
  }
}

function extractEventId(eventJson: string): string | null {
  try {
    const parsed = JSON.parse(eventJson) as unknown
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
