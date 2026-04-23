# NostrTun

> [!WARNING]
> This project is in early development. Protocol details, APIs, and
> package layout can change without notice. Not ready for production use.

HTTP tunneled over Nostr. Reach an app server by its **pubkey**, not its
IP or domain. End-to-end encrypted via NIP-59 gift wrap; no CA, no DNS,
no server IP exposed to clients.

```
 ┌────────┐   encrypted wrap    ┌────────┐   encrypted wrap    ┌────────┐
 │ client │ ── NIP-59 (req) ──▶ │ public │ ── NIP-59 (req) ──▶ │ server │
 │        │                     │ relay  │                     │        │
 │        │ ◀─ NIP-59 (res) ─── │  (ws)  │ ◀─ NIP-59 (res) ─── │        │
 └────────┘                     └────────┘                     └────────┘
  has: server pubkey            can't decrypt;                 Hono routes;
       + relay URL              fans out by #p tag             behind NAT,
                                                               no public IP
```

The app shell and the API are independent channels. Web clients pull
static assets from any CDN; native mobile apps skip that step entirely.
Either way, every API call goes through Nostr to a server that never
exposes a public IP:

```
 ┌────────────┐   HTTPS (web clients only)     ┌──────────────┐
 │  browser   │ ─── HTML · JS · CSS ────────── │ static host  │   any CDN
 │    PWA     │                                 └──────────────┘   (you don't
 │ mobile app │                                                     own this)
 │            │   NIP-59 wrap                   ┌────────┐    ┌──────────┐
 │            │ ─── every API call ───────────▶ │ public │ ─▶ │ your API │
 │            │                                 │ relay  │    │ (Hono)   │
 │            │ ◀── every response ─────────── │  (wss) │ ◀─ │          │
 └────────────┘                                 └────────┘    └──────────┘
                                                              no public IP
                                                              no DNS · no TLS
                                                              no cert rotation
```

The motivation is the same reason people run services as Telegram bots:
you get a callable endpoint without ever exposing the machine's real IP
— the messaging layer handles reachability. NostrTun does this over
Nostr instead of a centralized platform, so identity stays with a
pubkey you control and the relay is swappable.

## Why

```
 traditional stack:                      with nostr-tun:
 ─────────────────                       ──────────────

 browser ──HTTPS──▶ web app   (public)   browser ──HTTPS──▶ CDN   (public,
                                                                   rented)
 browser ──HTTPS──▶ API       (public)
                                         browser ──NIP-59──▶ relay
 both public boxes need:                                     │
   · public IP                                               ▼
   · DNS record                                          your API
   · TLS cert + renewal                                  ─────────
   · inbound firewall rule                                · NAT-bound
                                                          · outbound-only
                                                          · no IP/DNS/TLS
```

Traditional HTTP couples server **identity** to **network location**:
clients talk to `api.example.com` resolved to an IP, authenticated by a
CA cert. The server's IP is public and becomes an attack surface.

NostrTun decouples the two:
- **Identity** = Nostr pubkey (self-certifying, no CA).
- **Location** = a public Nostr relay that fans out encrypted events.

A client only needs the server's pubkey and one relay URL. The server's
actual IP is visible only to the relay (and can sit behind an outbound-
only VPN / residential connection / Tor). Compromise one relay → switch
relays, pubkey and session keep working.

Secondary effect: some metadata hiding. Client pubkey is already
anonymous at the relay level (wraps are signed by per-request ephemeral
keys). Server pubkey and timing/size are still exposed — see
[`doc/NOSTR_TUN_PRIVACY.md`](doc/NOSTR_TUN_PRIVACY.md) for the padding +
decoy-tag roadmap.

## What you write

A normal Hono route, unchanged. One middleware makes it also callable
over Nostr; the handler never sees wrap/unwrap.

```ts
app.post('/v1/hello', tunnel.route(), (c) => c.text('hi'))
//                    ^^^^^^^^^^^^^^^
//                    the only line that exposes this route over Nostr.
//                    Remove it and the endpoint becomes HTTPS-only again.
```

- **No protocol code in handlers.** Routes receive a regular `Request`
  and return a regular `Response`. Wrap/unwrap lives behind
  `tunnel.route()`.
- **Both channels, one codebase.** The Hono app keeps serving plain
  HTTP on its bound port. Expose HTTPS-only, Nostr-only, or both —
  a deployment choice, not a code change.
- **Reachable by pubkey OR by URL.** Clients that have the server's
  pubkey use the tunnel; clients hitting the HTTPS endpoint get an
  identical response from the same handler.

## Positioning

|  | VPN | Tor | I2P | **NostrTun** |
|---|---|---|---|---|
| Addressing | IP/DNS | `.onion` (pubkey hash) | b32 dest (pubkey hash) | **raw Nostr pubkey** |
| Hops | 1 | 3 | multi (2×) | **1 (relay)** |
| E2EE | no (provider trusted) | no (exit trusted) | yes | **yes** |
| Anonymity | none | strong | strong | weak (pubkey pair visible) |
| Latency | near-direct | 200–1000 ms | 300–1500 ms | **~37 ms local / ~300 ms remote** |
| Identity ↔ transport | bound (IP=session) | loose (circuit rotation) | loose | **fully decoupled** — change relay without losing address |

NostrTun is not a Tor replacement. Think of it as "TLS + DNS replaced by
pubkey + relay": CA-less authenticated RPC with a free-swappable message
bus. If full anonymity is needed, NostrTun composes cleanly on top of
Tor (swap the transport adapter).

## Architecture

Hexagonal. The domain cores (`NostrTunClient`, `NostrTun`) depend only on
port interfaces; concrete Nostr libraries plug in at the composition
root.

```
                   ports (contracts)
                         ▲
 ┌───────────────┐       │       ┌───────────────┐
 │ NostrTunClient │ ──────┤─────▶ │    NostrTun    │
 │  (client app) │       │       │ (server app)  │
 └───────────────┘       │       └───────────────┘
                         │
         ┌───────────────┴───────────────┐
         ▼                               ▼
 ┌──────────────────┐            ┌──────────────────┐
 │ @nostr-tun/ndk-    │            │ @nostr-tun/nostr-  │
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
[`doc/NOSTR_TUN_PERFORMANCE.md`](doc/NOSTR_TUN_PERFORMANCE.md)).

Packages:
- `@nostr-tun/core` — types and port interfaces only, zero deps.
- `@nostr-tun/server` — `NostrTun` class, Hono + in-memory storage adapters.
- `@nostr-tun/client` — `NostrTunClient` class.
- `@nostr-tun/ndk-adapters` — NDK-based Crypto / Relay / Transport.
- `@nostr-tun/nostr-tools-adapters` — nostr-tools + raw-WS variants.

## Stack

- [Bun](https://bun.sh) ≥ 1.1.30 (runtime, test, package manager)
- TypeScript (strict, composite builds)
- [Hono](https://hono.dev) — HTTP framework the server wraps
- [nostr-tools](https://github.com/nbd-wtf/nostr-tools) (default) or
  [NDK](https://github.com/nostr-dev-kit/ndk) for Nostr primitives

## Try it

Run the reference example (BTC price-alert bot) in two terminals — no local
relay, no DNS, no TLS setup. Uses public Nostr relays by default.

```bash
bun install

# terminal 1 — bot server (generates a keypair on first run)
cd packages/examples/btc-alert-bot/server \
  && cp .env.example .env \
  && bun run gen-keys:env \
  && bun run dev
# → prints the bot's hex pubkey; copy it

# terminal 2 — PWA (paste the pubkey into VITE_SERVER_PUBKEY)
cd packages/examples/btc-alert-bot/web \
  && cp .env.example .env.local \
  && bun run dev
# → http://localhost:5173
```

Full walkthrough, identity model, and endpoints:
[`packages/examples/btc-alert-bot`](packages/examples/btc-alert-bot).

## Usage

Server:

```ts
import { Hono } from 'hono'
import { NostrTun, HonoAdapter, InMemoryStorageAdapter } from '@nostr-tun/server'
import {
  NostrToolsCryptoAdapter,
  NostrToolsRelayAdapter,
} from '@nostr-tun/nostr-tools-adapters'

const app = new Hono()
const tunnel = new NostrTun({ relays: [RELAY], secretKey: serverSk, pubkey: serverPk, ttl: 60 })
  .useRelay(new NostrToolsRelayAdapter(RELAY, serverPk))
  .useCrypto(new NostrToolsCryptoAdapter())
  .useStorage(new InMemoryStorageAdapter())
  .useHttp(new HonoAdapter())
  .attachApp(app)

app.post('/v1/hello', tunnel.route(), (c) => c.text('hi'))
await tunnel.connect()
```

Client:

```ts
import { NostrTunClient } from '@nostr-tun/client'
import {
  NostrToolsCryptoAdapter,
  NostrToolsTransportAdapter,
} from '@nostr-tun/nostr-tools-adapters'

const client = new NostrTunClient({ secretKey: clientSk, ttl: 30 })
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

Set `NOSTR_TUN_ADAPTERS=ndk` to switch the harness to the NDK adapters.
`NOSTRUM_{CRYPTO,RELAY,TRANSPORT}=ndk|nostr-tools` let you mix per port.

## Examples

- [`packages/examples/btc-alert-bot`](packages/examples/btc-alert-bot) —
  BTC price-alert bot. Hono server + TUI-styled PWA; management API over
  Nostr (with NIP-98 auth), alerts delivered as Nostr DMs.

## Docs

- [`doc/NOSTR_TUN_PRIVACY.md`](doc/NOSTR_TUN_PRIVACY.md) — metadata-hardening roadmap
- [`doc/NOSTR_TUN_DISCOVERY.md`](doc/NOSTR_TUN_DISCOVERY.md) — HTTPS-first bootstrap + manifest
- [`doc/NOSTR_TUN_MILESTONES.md`](doc/NOSTR_TUN_MILESTONES.md) — development phases
- [`AGENTS.md`](AGENTS.md) — repo invariants

## License

[MIT](LICENSE) — © 2026 NostrTun contributors.
