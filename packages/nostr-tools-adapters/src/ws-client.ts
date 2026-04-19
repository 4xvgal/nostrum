export type RelayFilter = {
  kinds: number[]
  '#p': string[]
}

type EventHandler = (bytes: Uint8Array) => void

export class WsClient {
  #ws: WebSocket | null = null
  #url: string
  #subId: string
  #filter: RelayFilter | null = null
  #handler: EventHandler | null = null
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

  publish(eventJson: string): void {
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) {
      throw new Error('ws not open; call connect() first')
    }
    this.#ws.send(`["EVENT",${eventJson}]`)
  }

  async disconnect(): Promise<void> {
    this.#closed = true
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
    }
    // EOSE / OK / NOTICE ignored for one-shot RPC
  }
}
