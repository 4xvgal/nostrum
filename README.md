# Nostrum

> [!WARNING]
> This project is in early development. Protocol details, APIs, and
> package layout can change without notice. Not ready for production use.

HTTP tunneled over Nostr. Reach an app server by its **pubkey**, not its
IP or domain. End-to-end encrypted via NIP-59 gift wrap; no CA, no DNS,
no server IP exposed to clients.

The motivation is the same reason people run services as Telegram bots:
you get a callable endpoint without ever exposing the machine's real IP
— the messaging layer handles reachability. Nostrum does this over
Nostr instead of a centralized platform, so identity stays with a
pubkey you control and the relay is swappable.

## Why

Traditional HTTP couples server **identity** to **network location**:
clients talk to `api.example.com` resolved to an IP, authenticated by a
CA cert. The server's IP is public and becomes an attack surface.

Nostrum decouples the two:
- **Identity** = Nostr pubkey (self-certifying, no CA).
- **Location** = a public Nostr relay that fans out encrypted events.

A client only needs the server's pubkey and one relay URL. The server's
actual IP is visible only to the relay (and can sit behind an outbound-
only VPN / residential connection / Tor). Compromise one relay → switch
relays, pubkey and session keep working.

Secondary effect: some metadata hiding. Client pubkey is already
anonymous at the relay level (wraps are signed by per-request ephemeral
keys). Server pubkey and timing/size are still exposed — see
[`doc/NOSTRUM_PRIVACY.md`](doc/NOSTRUM_PRIVACY.md) for the padding +
decoy-tag roadmap.

## Positioning

|  | VPN | Tor | I2P | **Nostrum** |
|---|---|---|---|---|
| Addressing | IP/DNS | `.onion` (pubkey hash) | b32 dest (pubkey hash) | **raw Nostr pubkey** |
| Hops | 1 | 3 | multi (2×) | **1 (relay)** |
| E2EE | no (provider trusted) | no (exit trusted) | yes | **yes** |
| Anonymity | none | strong | strong | weak (pubkey pair visible) |
| Latency | near-direct | 200–1000 ms | 300–1500 ms | **~37 ms local / ~300 ms remote** |
| Identity ↔ transport | bound (IP=session) | loose (circuit rotation) | loose | **fully decoupled** — change relay without losing address |

Nostrum is not a Tor replacement. Think of it as "TLS + DNS replaced by
pubkey + relay": CA-less authenticated RPC with a free-swappable message
bus. If full anonymity is needed, Nostrum composes cleanly on top of
Tor (swap the transport adapter).

## Architecture

Hexagonal. The domain cores (`NostrumClient`, `Nostrum`) depend only on
port interfaces; concrete Nostr libraries plug in at the composition
root.

```
                   ports (contracts)
                         ▲
 ┌───────────────┐       │       ┌───────────────┐
 │ NostrumClient │ ──────┤─────▶ │    Nostrum    │
 │  (client app) │       │       │ (server app)  │
 └───────────────┘       │       └───────────────┘
                         │
         ┌───────────────┴───────────────┐
         ▼                               ▼
 ┌──────────────────┐            ┌──────────────────┐
 │ @nostrum/ndk-    │            │ @nostrum/nostr-  │
 │     adapters     │            │  tools-adapters  │
 │ (NDK-based)      │            │ (nostr-tools +   │
 │                  │            │  raw WebSocket)  │
 └──────────────────┘            └──────────────────┘
                  ▼         ▼
                 Nostr relay (WebSocket)
```

Three swappable ports: `CryptoPort`, `RelayPort` (server),
`TransportPort` (client). Each has an NDK implementation and a
`nostr-tools` + raw-WS implementation. Default is `nostr-tools`
(~20× faster than NDK for RPC-shaped workloads; see
[`doc/NOSTRUM_PERFORMANCE.md`](doc/NOSTRUM_PERFORMANCE.md)).

Packages:
- `@nostrum/core` — types and port interfaces only, zero deps.
- `@nostrum/server` — `Nostrum` class, Hono + in-memory storage adapters.
- `@nostrum/client` — `NostrumClient` class.
- `@nostrum/ndk-adapters` — NDK-based Crypto / Relay / Transport.
- `@nostrum/nostr-tools-adapters` — nostr-tools + raw-WS variants.

## Stack

- [Bun](https://bun.sh) ≥ 1.1.30 (runtime, test, package manager)
- TypeScript (strict, composite builds)
- [Hono](https://hono.dev) — HTTP framework the server wraps
- [nostr-tools](https://github.com/nbd-wtf/nostr-tools) (default) or
  [NDK](https://github.com/nostr-dev-kit/ndk) for Nostr primitives

## Usage

Server:

```ts
import { Hono } from 'hono'
import { Nostrum, HonoAdapter, InMemoryStorageAdapter } from '@nostrum/server'
import {
  NostrToolsCryptoAdapter,
  NostrToolsRelayAdapter,
} from '@nostrum/nostr-tools-adapters'

const app = new Hono()
const nostrum = new Nostrum({ relays: [RELAY], secretKey: serverSk, pubkey: serverPk, ttl: 60 })
  .useRelay(new NostrToolsRelayAdapter(RELAY, serverPk))
  .useCrypto(new NostrToolsCryptoAdapter())
  .useStorage(new InMemoryStorageAdapter())
  .useHttp(new HonoAdapter())
  .attachApp(app)

app.post('/v1/hello', nostrum.route(), (c) => c.text('hi'))
await nostrum.connect()
```

Client:

```ts
import { NostrumClient } from '@nostrum/client'
import {
  NostrToolsCryptoAdapter,
  NostrToolsTransportAdapter,
} from '@nostrum/nostr-tools-adapters'

const client = new NostrumClient({ secretKey: clientSk, ttl: 30 })
  .useTransport(new NostrToolsTransportAdapter(RELAY, clientPk))
  .useCrypto(new NostrToolsCryptoAdapter())
  .pin('https://api.example', { pubkey: serverPk, relays: [RELAY] })

const res = await client.fetch('https://api.example/v1/hello', {
  method: 'POST',
  body: 'hi',
})
```

## Develop

```bash
bun install
bun run typecheck
bun test
bun run smoke           # E2E round-trip against a local docker relay
bun run bench           # latency bench, 100 iterations
bun run bench-remote    # same, against a public relay
```

Set `NOSTRUM_ADAPTERS=ndk` to switch the harness to the NDK adapters.
`NOSTRUM_{CRYPTO,RELAY,TRANSPORT}=ndk|nostr-tools` let you mix per port.

## Docs

- [`doc/NOSTRUM_DESIGN.md`](doc/NOSTRUM_DESIGN.md) — protocol + hexagonal structure
- [`doc/NOSTRUM_PERFORMANCE.md`](doc/NOSTRUM_PERFORMANCE.md) — latency analysis + NDK vs nostr-tools matrix
- [`doc/NOSTRUM_PRIVACY.md`](doc/NOSTRUM_PRIVACY.md) — metadata-hardening roadmap
- [`doc/NOSTRUM_DISCOVERY.md`](doc/NOSTRUM_DISCOVERY.md) — HTTPS-first bootstrap + manifest
- [`doc/NOSTRUM_MILESTONES.md`](doc/NOSTRUM_MILESTONES.md) — development phases
- [`AGENTS.md`](AGENTS.md) — repo invariants
