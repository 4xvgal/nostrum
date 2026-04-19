import { describe, expect, test } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import { NostrToolsTransportAdapter } from './nostr-tools-transport.adapter.js'

type StubServer = {
  url: string
  stop: () => Promise<void>
}

function startOkFalseServer(reason: string): Promise<StubServer> {
  return new Promise((resolve) => {
    const server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        if (srv.upgrade(req)) return undefined
        return new Response(null, { status: 400 })
      },
      websocket: {
        message(ws: ServerWebSocket<unknown>, raw: string | Buffer) {
          if (typeof raw !== 'string') return
          let msg: unknown
          try {
            msg = JSON.parse(raw)
          } catch {
            return
          }
          if (Array.isArray(msg) && msg[0] === 'EVENT' && msg[1]) {
            const ev = msg[1] as { id?: unknown }
            if (typeof ev.id === 'string') {
              ws.send(JSON.stringify(['OK', ev.id, false, reason]))
            }
          }
        },
      },
    })
    resolve({
      url: `ws://localhost:${server.port}`,
      stop: async () => {
        server.stop(true)
      },
    })
  })
}

const FAKE_EVENT_JSON = JSON.stringify({
  id: 'a'.repeat(64),
  pubkey: 'b'.repeat(64),
  created_at: Math.floor(Date.now() / 1000),
  kind: 1059,
  tags: [],
  content: '',
  sig: 'c'.repeat(128),
})

describe('NostrToolsTransportAdapter — OK=false fast-fail', () => {
  test('onPublishError fires with event id + reason within 500ms', async () => {
    const reason = 'blocked: test'
    const server = await startOkFalseServer(reason)
    try {
      const adapter = new NostrToolsTransportAdapter(
        server.url,
        'd'.repeat(64),
      )
      await adapter.connect()

      const event = await new Promise<{ id: string; reason: string }>(
        (resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('onPublishError did not fire in 500ms')),
            500,
          )
          adapter.onPublishError((id, r) => {
            clearTimeout(timer)
            resolve({ id, reason: r })
          })
          void adapter.publish(new TextEncoder().encode(FAKE_EVENT_JSON))
        },
      )

      expect(event.id).toBe('a'.repeat(64))
      expect(event.reason).toBe(reason)
      await adapter.disconnect()
    } finally {
      await server.stop()
    }
  })

  test('OK=true is silently cleared — no error handler call', async () => {
    const server = await new Promise<StubServer>((resolve) => {
      const srv = Bun.serve({
        port: 0,
        fetch(req, s) {
          if (s.upgrade(req)) return undefined
          return new Response(null, { status: 400 })
        },
        websocket: {
          message(ws, raw) {
            if (typeof raw !== 'string') return
            const msg = JSON.parse(raw)
            if (Array.isArray(msg) && msg[0] === 'EVENT' && msg[1]?.id) {
              ws.send(JSON.stringify(['OK', msg[1].id, true, '']))
            }
          },
        },
      })
      resolve({
        url: `ws://localhost:${srv.port}`,
        stop: async () => {
          srv.stop(true)
        },
      })
    })

    try {
      const adapter = new NostrToolsTransportAdapter(
        server.url,
        'd'.repeat(64),
      )
      await adapter.connect()

      let called = false
      adapter.onPublishError(() => {
        called = true
      })
      await adapter.publish(new TextEncoder().encode(FAKE_EVENT_JSON))
      await new Promise((r) => setTimeout(r, 150))

      expect(called).toBe(false)
      await adapter.disconnect()
    } finally {
      await server.stop()
    }
  })
})
