import type { NostrRequest, NostrResponse } from '@nostr-tun/core'
import type { HttpPort } from '../../ports/http.port.js'

const BODYLESS_METHODS = new Set(['GET', 'HEAD'])

export class HonoAdapter implements HttpPort {
  toRequest(req: NostrRequest): Request {
    const url = `http://nostr-tun.local${req.path}`
    const headers = new Headers(req.headers)
    headers.set('x-nostr-tun-principal', req.principal)

    const method = req.method.toUpperCase()
    const init: RequestInit = { method, headers }
    if (!BODYLESS_METHODS.has(method) && req.body !== null) {
      init.body = req.body as BodyInit
    }
    return new Request(url, init)
  }

  async toNostrResponse(id: string, res: Response): Promise<NostrResponse> {
    const buf = await res.arrayBuffer()
    const bytes = buf.byteLength === 0 ? null : new Uint8Array(buf)
    const headers: Record<string, string> = {}
    res.headers.forEach((value, key) => {
      headers[key] = value
    })
    return {
      id,
      status: res.status,
      headers,
      body: bytes,
    }
  }
}
