import { Hono } from 'hono'
import NDK, { NDKPrivateKeySigner } from '@nostr-dev-kit/ndk'
import { NdkCryptoAdapter } from '@nostrum/ndk-adapters'
import {
  HonoAdapter,
  InMemoryStorageAdapter,
  NdkRelayAdapter,
  Nostrum,
} from '@nostrum/server'
import {
  NdkTransportAdapter,
  NostrumClient,
  type NostrumClientConfig,
} from '@nostrum/client'

export const RELAY_URL = process.env.RELAY_URL ?? 'ws://localhost:7777'
export const HTTP_PORT = Number(process.env.HTTP_PORT ?? 3000)
export const ORIGIN = `http://localhost:${HTTP_PORT}`

async function runCmd(argv: string[]): Promise<void> {
  const proc = Bun.spawn(argv, { stdout: 'inherit', stderr: 'inherit' })
  await proc.exited
  if (proc.exitCode !== 0) {
    throw new Error(`${argv.join(' ')} exited with code ${proc.exitCode}`)
  }
}

async function waitForRelay(url: string, timeoutMs = 30000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const ready = await new Promise<boolean>((resolve) => {
      try {
        const ws = new WebSocket(url)
        const timer = setTimeout(() => {
          try {
            ws.close()
          } catch {}
          resolve(false)
        }, 800)
        ws.onopen = () => {
          clearTimeout(timer)
          ws.close()
          resolve(true)
        }
        ws.onerror = () => {
          clearTimeout(timer)
          resolve(false)
        }
      } catch {
        resolve(false)
      }
    })
    if (ready) return
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`Relay ${url} not ready after ${timeoutMs}ms`)
}

let signalHandlersInstalled = false
function installSignalHandlers(): void {
  if (signalHandlersInstalled) return
  signalHandlersInstalled = true
  const cleanup = async (sig: NodeJS.Signals): Promise<void> => {
    console.log(`\n[relay] caught ${sig} — tearing down`)
    await stopRelay().catch(() => {})
    process.exit(130)
  }
  process.on('SIGINT', (s) => void cleanup(s))
  process.on('SIGTERM', (s) => void cleanup(s))
}

async function startRelay(): Promise<void> {
  installSignalHandlers()
  console.log('[relay] bringing up fresh container (with clean volume)')
  // -v wipes any prior volume so each run starts empty
  await runCmd(['docker', 'compose', 'down', '-v'])
  await runCmd(['docker', 'compose', 'up', '-d'])
  console.log('[relay] waiting for readiness')
  await waitForRelay(RELAY_URL)
  console.log('[relay] ready')
}

async function stopRelay(): Promise<void> {
  console.log('[relay] tearing down (volume included)')
  await runCmd(['docker', 'compose', 'down', '-v'])
}

export type SmokeEnv = {
  app: Hono
  nostrum: Nostrum
  client: NostrumClient
  httpServer: ReturnType<typeof Bun.serve>
  keys: {
    clientPk: string
    clientSk: string
    serverPk: string
    serverSk: string
  }
  transports: string[] // handler observes each call ('http' | 'nostr')
  shutdown: () => Promise<void>
}

const skipDocker = (): boolean => process.env.SKIP_DOCKER === '1'

export async function setupEnv(
  clientConfig: Omit<NostrumClientConfig, 'secretKey'> = { ttl: 30 },
): Promise<SmokeEnv> {
  if (!skipDocker()) await startRelay()
  try {
    return await buildEnv(clientConfig)
  } catch (e) {
    if (!skipDocker()) await stopRelay().catch(() => {})
    throw e
  }
}

function logStep(msg: string): void {
  console.log(`[setup] ${msg}`)
}

async function withTimeout<T>(
  label: string,
  p: Promise<T>,
  ms: number,
): Promise<T> {
  let warned = false
  const warn = setTimeout(() => {
    warned = true
    console.warn(`[setup] ${label} still running after ${ms}ms — possibly stuck`)
  }, ms)
  try {
    const result = await p
    clearTimeout(warn)
    if (warned) console.log(`[setup] ${label} eventually resolved`)
    return result
  } catch (e) {
    clearTimeout(warn)
    throw e
  }
}

async function buildEnv(
  clientConfig: Omit<NostrumClientConfig, 'secretKey'>,
): Promise<SmokeEnv> {
  logStep(`relay=${RELAY_URL} httpPort=${HTTP_PORT}`)

  const clientSigner = NDKPrivateKeySigner.generate()
  const serverSigner = NDKPrivateKeySigner.generate()
  const clientSk = clientSigner.privateKey
  const clientPk = clientSigner.pubkey
  const serverSk = serverSigner.privateKey
  const serverPk = serverSigner.pubkey
  logStep(
    `keys client=${clientPk.slice(0, 12)} server=${serverPk.slice(0, 12)}`,
  )

  const serverNdk = new NDK({
    explicitRelayUrls: [RELAY_URL],
    signer: serverSigner,
  })
  const clientNdk = new NDK({
    explicitRelayUrls: [RELAY_URL],
    signer: clientSigner,
  })
  logStep('NDK instances created')

  const app = new Hono()
  const nostrum = new Nostrum({
    relays: [RELAY_URL],
    secretKey: serverSk,
    ttl: 60,
    pubkey: serverPk,
  })
    .useRelay(new NdkRelayAdapter(serverNdk, serverPk))
    .useCrypto(new NdkCryptoAdapter(serverNdk))
    .useStorage(new InMemoryStorageAdapter())
    .useHttp(new HonoAdapter())
    .attachApp(app)

  app.use('*', nostrum.advertise())
  app.get('/.well-known/nostrum.json', nostrum.manifest())

  const transports: string[] = []
  app.post('/v1/echo', nostrum.route(), async (c) => {
    const principal = c.req.header('x-nostrum-principal')
    transports.push(principal ? 'nostr' : 'http')
    const body = await c.req.text()
    return c.json({ echoed: body, principal: principal ?? null })
  })

  logStep(`starting HTTP server on :${HTTP_PORT}`)
  const httpServer = Bun.serve({ port: HTTP_PORT, fetch: app.fetch })
  logStep('HTTP server ready')

  logStep('nostrum.connect() — server-side relay subscribe')
  const connectStart = Date.now()
  await withTimeout('nostrum.connect', nostrum.connect(), 15000)
  logStep(`server subscribed (${Date.now() - connectStart}ms)`)

  const client = new NostrumClient({
    secretKey: clientSk,
    ...clientConfig,
  })
    .useTransport(new NdkTransportAdapter(clientNdk, clientPk))
    .useCrypto(new NdkCryptoAdapter(clientNdk))
  logStep('NostrumClient built (client transport connects lazily on first fetch)')

  const shutdown = async (): Promise<void> => {
    await client.disconnect()
    await nostrum.disconnect()
    httpServer.stop()
    await new Promise((r) => setTimeout(r, 100))
    if (!skipDocker()) await stopRelay()
  }

  return {
    app,
    nostrum,
    client,
    httpServer,
    keys: { clientPk, clientSk, serverPk, serverSk },
    transports,
    shutdown,
  }
}
