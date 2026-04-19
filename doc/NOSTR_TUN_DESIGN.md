# NostrTun — Monorepo Architecture Design

> A TypeScript library that exposes existing Hono API routes as Nostr endpoints,
> and provides a fetch()-compatible client to consume them.
> The actual Nostr protocol work (relay pool, event signing, NIP-44 / NIP-59
> Gift Wrap) is delegated to [NDK](https://github.com/nostr-dev-kit/ndk).
> NostrTun is a thin hexagonal shell around NDK.
> This document describes **structure and contracts only**. No implementation logic.
> Behavior descriptions are in English prose.

---

## Monorepo Structure

```
nostr-tun/
├── packages/
│   ├── core/                    # @nostr-tun/core — no external deps (pure)
│   │   └── src/
│   │       ├── types/
│   │       │   └── index.ts         # Shared domain types
│   │       └── ports/
│   │           └── crypto.port.ts   # Shared by server & client
│   ├── ndk-adapters/            # @nostr-tun/ndk-adapters — shared NDK-backed adapters
│   │   └── src/
│   │       └── ndk-crypto.adapter.ts     # implements core CryptoPort (uses NDK NIP-44/59)
│   ├── server/                  # @nostr-tun/server — depends on core + ndk-adapters
│   │   └── src/
│   │       ├── app/                      # hexagon wiring (composition root)
│   │       │   └── tunnel.ts
│   │       ├── ports/
│   │       │   ├── storage.port.ts
│   │       │   ├── relay.port.ts
│   │       │   └── http.port.ts
│   │       ├── correlation-manager.ts
│   │       └── adapters/
│   │           ├── storage/
│   │           │   └── in-memory.adapter.ts      # implements StoragePort
│   │           ├── relay/
│   │           │   └── ndk-relay.adapter.ts      # implements RelayPort (uses NDK relay pool)
│   │           └── http/
│   │               └── hono.adapter.ts
│   └── client/                  # @nostr-tun/client — depends on core + ndk-adapters
│       └── src/
│           ├── app/                      # hexagon wiring (composition root)
│           │   └── tunnel-client.ts     # HTTPS-first dual-mode dispatcher;
│           │                             # owns origin cache + pending-request map
│           ├── ports/
│           │   ├── transport.port.ts
│           │   └── discovery.port.ts            # extension point for external
│           │                                    # strategies (NIP-05, DNS, …) —
│           │                                    # implementations live elsewhere
│           └── adapters/
│               └── transport/
│                   └── ndk-transport.adapter.ts # implements TransportPort (uses NDK)
├── package.json                 # Bun workspaces root
└── README.md
```

```json
// package.json (root)
{
  "name": "nostr-tun",
  "workspaces": ["packages/*"]
}
```

---

## Runtime Target

> Bun is used as a **development tool only** (workspace manager, test runner,
> script runner). It is **not** a runtime requirement.
>
> - **Publish target:** ES2022, standard Web APIs (`fetch`, `WebSocket`,
>   `TextEncoder`, `crypto.subtle`).
> - **Server runtimes supported:** Node (18+), Bun, Deno, Cloudflare Workers,
>   Vercel Edge — anywhere Hono runs.
> - **Client runtimes supported:** modern browsers, Node (18+), Bun, Deno,
>   React Native.
> - **Bun-specific APIs** (`Bun.serve`, `Bun.sql`, `Bun.file`, etc.) must not
>   appear in published package code. The Server Usage Example uses
>   `@hono/node-server` as its concrete runtime adapter; alternates for
>   Bun / Workers / Edge are shown as one-line comments alongside it.

---

## Package Dependency Graph

```
@nostr-tun/core                  (pure — no external deps)
       ▲
       │ consumed by
       │
@nostr-tun/ndk-adapters ──► @nostr-dev-kit/ndk
       ▲
       │ consumed by
       │
@nostr-tun/server ──► @nostr-dev-kit/ndk (server-local adapters)
@nostr-tun/client ──► @nostr-dev-kit/ndk (client-local adapters)
```

- **`@nostr-tun/core`** — no external deps. Pure domain: shared types and
  the shared `CryptoPort`. Does not know NDK exists.
- **`@nostr-tun/ndk-adapters`** — houses adapters whose implementation is
  identical on both sides (currently just `NdkCryptoAdapter`). Depends on
  `@nostr-tun/core` and `@nostr-dev-kit/ndk`. Single source of truth for
  shared NDK-backed port implementations.
- **`@nostr-tun/server`** — depends on `@nostr-tun/core`,
  `@nostr-tun/ndk-adapters`, and `@nostr-dev-kit/ndk`. Owns `StoragePort`,
  `CorrelationManager`, and server-only adapters (`NdkRelayAdapter`,
  `HonoAdapter`, `InMemoryStorageAdapter`). Storage and correlation are
  server-only because the client cannot persist its in-flight state
  (`Promise` resolvers are not serializable — see `NostrTunClient` below).
- **`@nostr-tun/client`** — depends on `@nostr-tun/core`,
  `@nostr-tun/ndk-adapters`, and `@nostr-dev-kit/ndk`. Ships only the
  `NdkTransportAdapter`; the in-band Tor-style discovery flow
  (`Nostr-Tun-Location` header + `/.well-known/nostr-tun.json` manifest) is
  built directly into `NostrTunClient`. The `DiscoveryPort` interface
  remains as an extension point for external strategies (NIP-05, DNS TXT,
  custom directories) documented in `NOSTR_TUN_DISCOVERY.md` — none of
  those adapters live in this package. `NostrTunClient` keeps an internal
  in-memory pending-request map and an origin cache; no `StoragePort` is
  exposed.

Server and client do not depend on each other.

**Hexagonal boundary:** core imports nothing external. Adapters are the *only*
place where NDK symbols (`NDK`, `NDKEvent`, `NDKPrivateKeySigner`, etc.) appear.
Swapping NDK for another Nostr library only requires rewriting the adapter
packages — core, ports, and the hexagon wiring stay unchanged.

---

---

# @nostr-tun/core

> Shared primitives used by both server and client.
> Contains shared domain types (`NostrRequest`, `NostrResponse`,
> `ServerInfo`, `KindSet`) and the shared `CryptoPort`.
> Core contains **no adapters and no external dependencies**.
> All Nostr-protocol logic lives behind ports and is implemented by NDK-backed
> adapters in the server and client packages.

---

## Domain Types (`core/src/types/index.ts`)

```typescript
// The decoded content of an inbound request envelope, after any transport-level
// unwrapping. Maps directly to an HTTP request.
type NostrRequest = {
  id: string                      // Correlation ID — 16-byte random hex (32 chars)
  method: string                  // HTTP method: GET, POST, PUT, DELETE, PATCH
  path: string                    // HTTP path: /v1/mint/quote
  headers: Record<string, string>
  body: Uint8Array | null
  principal: string               // Opaque caller identity. NDK adapter: Nostr pubkey hex.
  expiresAt: number               // Unix timestamp — TTL boundary
}

// The outbound payload sent back after handler execution.
type NostrResponse = {
  id: string                      // Same Correlation ID as the inbound request
  status: number                  // HTTP status code
  headers: Record<string, string>
  body: Uint8Array | null
}

// Per-origin server identity. Source-agnostic: produced by `Nostr-Tun-Location`
// parsing, manifest fetch, `pin()`, or any external `DiscoveryPort` adapter.
type ServerInfo = {
  pubkey: string                  // Server's Nostr pubkey (hex)
  relays: string[]                // wss:// relay URLs. v0 uses relays[0] only;
                                  // v1 dials all of them and dedups responses
                                  // by Correlation ID.
}
```

---

## Kind Configuration (`core/src/types/kinds.ts`)

> The Nostr `kind` numbers used for rumor/wrap layers are the only protocol
> values that vary across implementations (NostrTun native vs NIP-80 draft vs
> private deployments). They are **injected into adapters**, not hardcoded.
> The seal kind is fixed at `13` by NIP-59 and is therefore not configurable.

```typescript
type KindSet = {
  requestRumor: number   // inner unsigned event — request payload
  responseRumor: number  // inner unsigned event — response payload
  wrap: number           // outer gift wrap (1059 stored, 21059 ephemeral)
}

// Default — current NostrTun custom kinds, in the ephemeral range for rumors,
// regular NIP-59 wrap. Backward-compatible with NIP-17 infrastructure.
const KINDS_NOSTR_TUN: KindSet = {
  requestRumor:  21910,
  responseRumor: 21911,
  wrap:          1059,
}

// Aligned with nostr-protocol/nips#1276 (draft "NIP-80"). Uses ephemeral
// gift wrap — relays do not persist. Interop target with http2nostr /
// nostr2http reference implementations.
const KINDS_NIP80: KindSet = {
  requestRumor:  80,
  responseRumor: 81,
  wrap:          21059,
}
```

**Injection rule:** every adapter that reads or writes kind numbers accepts
`KindSet` as an optional constructor argument, defaulting to `KINDS_NOSTR_TUN`.
Three adapters are affected: `NdkCryptoAdapter` (builds rumors and wraps),
`NdkRelayAdapter` and `NdkTransportAdapter` (filter subscriptions by wrap kind).

Third-party `KindSet` values are allowed — private deployments can pick any
numbers without forking adapters.

---

## Shared Ports

### `CryptoPort` (`core/src/ports/crypto.port.ts`)

> Defines the Gift Wrap / NIP-44 encryption boundary.
> Implementations live in the server and client packages and internally use
> NDK's NIP-44 and NIP-59 primitives. Core does not import NDK.

```typescript
interface CryptoPort {
  // Decrypts transport-wrapped bytes and returns a request payload.
  // Returns null on decryption failure OR when the inner rumor's kind is
  // not the configured requestRumor kind (e.g., a stray response event).
  // Used by the server.
  unwrapRequest(wrappedBytes: Uint8Array, callerSecretKey: string): Promise<NostrRequest | null>

  // Same contract, but expects a response rumor. Used by the client.
  unwrapResponse(wrappedBytes: Uint8Array, callerSecretKey: string): Promise<NostrResponse | null>

  // Encrypts a payload into a wrapped envelope addressed to the recipient.
  // The inner rumor kind is chosen from the payload's shape (presence of
  // `status` ⇒ response ⇒ kinds.responseRumor; otherwise request).
  // Returns signed, ready-to-publish bytes.
  wrap(
    payload: NostrRequest | NostrResponse,
    recipientPubkey: string,
    callerSecretKey: string,
    ttl: number
  ): Promise<Uint8Array>
}
```

**Why split `unwrap`:** the server only ever decrypts requests and the client
only ever decrypts responses; making this asymmetry visible at the type level
removes a runtime shape check and prevents accidentally feeding a response
event into the server pipeline (or vice versa). `wrap` stays unified because
the caller already knows which payload it's holding.

---

---

# @nostr-tun/ndk-adapters

> Single source of truth for adapters whose implementation is identical on
> both server and client. Currently contains only `NdkCryptoAdapter`.
> Depends on `@nostr-tun/core` and `@nostr-dev-kit/ndk`. Does **not** depend on
> `@nostr-tun/server` or `@nostr-tun/client` — both sides consume this package
> as a peer.

---

## `NdkCryptoAdapter` (`ndk-adapters/src/ndk-crypto.adapter.ts`)

> Implements core `CryptoPort` on top of NDK. Symmetric by design — the same
> class is used for both the server (`unwrapRequest` / `wrap` on responses)
> and the client (`wrap` on requests / `unwrapResponse`).
>
> `unwrapRequest()` / `unwrapResponse()`: construct an `NDKEvent` from the raw
> bytes, use NDK's NIP-44 primitives to decrypt the outer wrap with the
> caller secret key, decrypt the inner kind-13 seal, parse the rumor
> `content` JSON, and return a `NostrRequest` / `NostrResponse`.
> Populate `principal` from `seal.pubkey`. Return `null` on:
>   - any decryption failure,
>   - outer kind ≠ `kinds.wrap`, or
>   - inner rumor kind ≠ the kind expected by the called method
>     (`kinds.requestRumor` for `unwrapRequest`, `kinds.responseRumor` for
>     `unwrapResponse`).
>
> `wrap()`: chooses the inner rumor kind from the payload shape — presence of
> a `status` field ⇒ `kinds.responseRumor`, otherwise `kinds.requestRumor`.
> Seals it (kind 13) with the caller's signer, wraps it (kind `kinds.wrap`)
> with a fresh ephemeral `NDKPrivateKeySigner`, sets the NIP-40 expiration
> tag to `now + ttl` (omitted when `kinds.wrap === 21059`), signs, and
> returns the serialized event bytes.

```typescript
import type NDK from '@nostr-dev-kit/ndk'
import type { CryptoPort, NostrRequest, NostrResponse, KindSet } from '@nostr-tun/core'
import { KINDS_NOSTR_TUN } from '@nostr-tun/core'

class NdkCryptoAdapter implements CryptoPort {
  constructor(private ndk: NDK, private kinds: KindSet = KINDS_NOSTR_TUN)
  unwrapRequest(wrappedBytes: Uint8Array, callerSecretKey: string): Promise<NostrRequest | null>
  unwrapResponse(wrappedBytes: Uint8Array, callerSecretKey: string): Promise<NostrResponse | null>
  wrap(
    payload: NostrRequest | NostrResponse,
    recipientPubkey: string,
    callerSecretKey: string,
    ttl: number
  ): Promise<Uint8Array>
}
```

The adapter uses `kinds.requestRumor` / `kinds.responseRumor` when building the
inner rumor, and `kinds.wrap` when constructing the outer envelope. Any incoming
event whose outer kind does not match `kinds.wrap` is rejected.

---

---

# @nostr-tun/server

> Hono middleware that exposes existing routes as Nostr endpoints.
> Depends on `@nostr-tun/core`, `@nostr-tun/ndk-adapters`, and `@nostr-dev-kit/ndk`.
> NDK is the sole implementation used for relay connectivity, event signing,
> NIP-44 encryption, and NIP-59 Gift Wrap construction. NDK symbols appear
> only inside `adapters/` or come from `@nostr-tun/ndk-adapters`.

---

## Client Event Specification

> This section defines the wire format that any NostrTun-compatible client must produce.
> Server-side `CryptoPort.unwrapRequest()` (implemented by `NdkCryptoAdapter`) expects
> exactly this structure.

### Discovery & Capability Advertisement

> **NostrTun core does not perform discovery.** The protocol takes
> `pubkey + relays + path` as inputs and produces a round-trip. *How* the
> client learns those inputs is layered on top, with three independent
> strategies — pick any combination:
>
> 1. **Direct** (default, zero infra): caller hardcodes `{ pubkey, relays }`
>    per origin. Suitable for trusted out-of-band setups, integration tests,
>    and clients that already pinned a server.
> 2. **In-band advertisement** (defined below): server's existing HTTPS
>    endpoint emits a `Nostr-Tun-Location` response header and exposes
>    `/.well-known/nostr-tun.json`. Modeled on Tor's `Onion-Location`. This
>    is NostrTun's first-party mechanism — defined as part of the protocol
>    because it requires server-side library support.
> 3. **External lookup** (NIP-05, DNS TXT, hand-rolled directories, …):
>    pluggable via `DiscoveryPort` on the client. Not specified here — see
>    `NOSTR_TUN_DISCOVERY.md` (separate doc) for adapters and grammars.
>    All external strategies reduce to the same `{ pubkey, relays[] }` shape.

#### `Nostr-Tun-Location` HTTP response header

Origin-level signal. Tells a NostrTun-aware client "I exist on Nostr at this
identity; consider switching transport." Server-side opt-in via
`nostr-tun.advertise()` middleware (defined later); clients without NostrTun
support ignore the unknown header and stay on plain HTTPS — fully
backward-compatible.

```
Nostr-Tun-Location: pubkey=<hex>; relays=<wss_url>[,<wss_url>...]; ma=<seconds>

// Example
Nostr-Tun-Location: pubkey=abc123…; relays=wss://r1.example.com,wss://r2.example.com; ma=300
```

| Param | Required | Notes |
|---|---|---|
| `pubkey` | yes | Server's Nostr pubkey (hex). |
| `relays` | yes | Comma-separated wss URLs. v0 clients dial `relays[0]` only. |
| `ma` | no | Max-age in seconds for the origin cache. Default `300`. |

**Trust model:** the header is delivered over the existing TLS connection
to the origin. The TLS certificate authenticates the domain, and the
header binds that domain to the advertised Nostr pubkey — exactly the
trust-bootstrap pattern Tor uses for `Onion-Location`. After the first
successful HTTPS contact, the client treats the pubkey as authentic for
the cache TTL.

#### `/.well-known/nostr-tun.json` capability manifest

Route-level catalog. Tells the client *which paths* are exposed over
Nostr, plus protocol capability flags. Auto-generated by
`nostr-tun.manifest()` from the Hono route table — operators do not write
or sync this list.

```json
{
  "version": "0.1",
  "pubkey":  "<hex>",
  "relays":  ["<wss_url>", "..."],
  "ttl":     300,
  "capabilities": {
    "kindSet":  "nostr-tun",
    "chunking": false
  },
  "routes": [
    { "method": "POST", "path": "/v1/quote",     "kind": "literal" },
    { "method": "GET",  "path": "/v1/users/:id", "kind": "pattern" }
  ]
}
```

| Field | Notes |
|---|---|
| `version` | Manifest schema version. Bump on breaking changes. |
| `pubkey`, `relays`, `ttl` | Same semantics as the header. |
| `capabilities.kindSet` | `"nostr-tun"` \| `"nip80"` \| custom `KindSet` object. |
| `capabilities.chunking` | `false` in v0 (rejects oversize), `true` in v1. |
| `routes[].method` | Uppercase HTTP verb. |
| `routes[].path` | Hono path syntax (`:param` for segments). |
| `routes[].kind` | `"literal"` (exact match) or `"pattern"` (template). |

Manifest endpoint should be served with `Cache-Control: public, max-age=<ttl>`
so CDNs/intermediaries cache it.

#### Runtime fallback — `501` + `x-nostr-tun-error`

Safety net for stale manifests, race conditions during deployment, or
clients that didn't fetch the manifest. If a NostrTun request arrives for a
path that is **not** registered with `nostr-tun.route()`, the server
responds with:

```
status:  501
headers: { "x-nostr-tun-error": "route-not-enabled" }
body:    null
```

Client SDK behavior on receiving this:
1. Mark `(origin, method, path)` as Nostr-disabled in its origin cache.
2. Re-issue the call over plain HTTPS transparently.
3. Refresh the manifest on next opportunity (pre-emptive or lazy).

This makes `nostr-tun.route()` simultaneously a **mount marker**
(manifest derives the route list from it) and a **runtime gatekeeper**
(non-marked handlers are never invoked from Nostr-decoded inputs, even
if Hono's path router would otherwise match them — the dispatcher
checks for the marker before calling `next()`). One declaration, two
guarantees.

---

### Rumor Content Schema — Request (kind 21910 by default)

The innermost layer of the Gift Wrap is a rumor with the `requestRumor` kind
from the active `KindSet` (default `21910`, or `80` under `KINDS_NIP80`).
Its `content` field is a JSON string:

```json
{
  "id":           "<16-byte random hex, 32 chars>",
  "method":       "<GET | POST | PUT | DELETE | PATCH>",
  "path":         "/v1/mint/quote",
  "headers":      { "content-type": "application/json" },
  "body":         "<string>",
  "bodyEncoding": "utf8"
}
```

| Field | Required | Notes |
|---|---|---|
| `id` | yes | Correlation ID. 32-char hex. Generated fresh per request. |
| `method` | yes | Uppercase HTTP verb. |
| `path` | yes | Must start with `/`. Include query params in path string. |
| `headers` | yes | At minimum `content-type` when body is present. |
| `body` | no | String form of the body, encoded per `bodyEncoding`. Omit or `null` when there is no body (e.g., GET/DELETE). |
| `bodyEncoding` | no | `"utf8"` (textual: JSON, form, plain), `"base64"` (binary), or `null`/absent (no body). |

**Decoding rule:** the receiver decodes `body` using `bodyEncoding` *only*.
`content-type` is informational metadata and must not influence decoding —
this avoids the ambiguity of inferring binary-vs-text from the header set.

---

### Rumor Content Schema — Response (kind 21911 by default)

The server's reply rumor has the `responseRumor` kind from the active `KindSet`
(default `21911`, or `81` under `KINDS_NIP80`):

```json
{
  "id":           "<same Correlation ID as the request>",
  "status":       200,
  "headers":      { "content-type": "application/json" },
  "body":         "<string>",
  "bodyEncoding": "utf8"
}
```

`body` / `bodyEncoding` follow the same rules as the request rumor.

---

### Gift Wrap Layering (NIP-59, constructed via NDK)

Kinds shown below are the `KINDS_NOSTR_TUN` defaults. Under `KINDS_NIP80` the
rumor kinds become `80`/`81` and the wrap kind becomes `21059` (ephemeral).
Seal kind is fixed at `13` by NIP-59.

Request (client → server):
```
kind <requestRumor> rumor   ← request content JSON (unsigned)
                              default 21910, KINDS_NIP80 = 80
  └─ kind 13 seal            ← NIP-44 encrypted with server pubkey, signed by client key
       └─ kind <wrap> wrap   ← NIP-44 re-encrypted, signed by ephemeral key
                              default 1059 (stored), KINDS_NIP80 = 21059 (ephemeral)
                              p tag = server pubkey
                              expiration tag = now + TTL (NIP-40)
                              * expiration tag OMITTED when wrap = 21059
                                (ephemeral — relays don't store)
```

Response (server → client):
```
kind <responseRumor> rumor   ← response content JSON (unsigned)
                              default 21911, KINDS_NIP80 = 81
  └─ kind 13 seal             ← NIP-44 encrypted with client pubkey, signed by server key
       └─ kind <wrap> wrap    ← NIP-44 re-encrypted, signed by ephemeral key
                              p tag = inbound seal.pubkey
                                      (= NostrRequest.principal, the client's real
                                       pubkey — NOT the inbound wrap's ephemeral
                                       pubkey. The client subscribes with
                                       #p=[clientRealPubkey], so addressing the
                                       response to the ephemeral key would never
                                       match the subscription.)
                              expiration tag behavior: same rule as request
```

Seal and wrap construction is performed with NDK's NIP-44 primitives and
`NDKEvent.sign()`; the ephemeral keypair is generated via `NDKPrivateKeySigner.generate()`.

---

### Field Mapping — Rumor to NostrRequest

After two layers of decryption, the server maps the rumor to `NostrRequest`:

```
rumor.content.id            → NostrRequest.id
rumor.content.method        → NostrRequest.method
rumor.content.path          → NostrRequest.path
rumor.content.headers       → NostrRequest.headers
rumor.content.body
  + rumor.content.bodyEncoding
                            → NostrRequest.body  (Uint8Array | null)
seal.pubkey                 → NostrRequest.principal
                              → x-nostr-tun-principal request header
wrap.tags[expiration]       → NostrRequest.expiresAt
```

---

## Ports

> `CryptoPort` is **imported from `@nostr-tun/core`**. The ports below are
> server-only. `StoragePort` lives here (not in core) because the client
> has no use for it — see the package dependency notes above and the
> `NostrTunClient` section.

### `StoragePort` (`server/src/ports/storage.port.ts`)

> Defines how server-side correlation state is persisted.
> Consumed by `CorrelationManager`. v0 ships an in-memory adapter; v1
> swaps in Redis (or any equivalent shared KV) to support restart and
> horizontal scale.

```typescript
// Persisted state for a single in-flight request-response round trip.
type CorrelationEntry = {
  principal: string               // Opaque caller identity used to address the reply.
  expiresAt: number               // Unix timestamp — used to reject stale responses
}

interface StoragePort {
  // Atomic compare-and-set. Returns true when the entry was newly stored,
  // false when an entry with the same id already exists (no write made).
  // Foundation for inbound-event idempotency (see CorrelationManager).
  setIfAbsent(id: string, entry: CorrelationEntry): Promise<boolean>

  set(id: string, entry: CorrelationEntry): Promise<void>
  get(id: string): Promise<CorrelationEntry | null>
  delete(id: string): Promise<void>
}
```

### `RelayPort`

> Defines how the server talks to a Nostr relay.
> The adapter behind this port owns the relay lifecycle; in the default
> `NdkRelayAdapter` this lifecycle is delegated to NDK.

```typescript
interface RelayPort {
  // Connects to the relay(s) and subscribes to events addressed to the
  // server's pubkey. Resolves when the first relay acknowledges the subscription.
  connect(): Promise<void>

  // Registers a callback that fires each time a matching inbound event arrives.
  // Raw event bytes are passed as-is; decryption is not this port's concern.
  onEvent(handler: (rawEvent: Uint8Array) => void): void

  // Publishes a signed, encrypted Nostr event to the relay.
  publish(event: Uint8Array): Promise<void>

  // Closes all relay connections gracefully.
  disconnect(): Promise<void>
}
```

### `HttpPort`

> Defines how the server converts between Nostr domain types and Hono-native types.

```typescript
interface HttpPort {
  // Converts a decoded NostrRequest into a standard Web API Request object
  // so that Hono's router can dispatch it without any awareness of Nostr.
  toRequest(nostrRequest: NostrRequest): Request

  // Converts the Hono handler's Response into a NostrResponse
  // ready for encryption and publishing.
  toNostrResponse(id: string, response: Response): Promise<NostrResponse>
}
```

---

## Adapters

> `NdkCryptoAdapter` is **not** defined here — it is imported from
> `@nostr-tun/ndk-adapters` (single source of truth, shared with the client).

### `NdkRelayAdapter`

> Implements RelayPort using NDK's relay pool.
>
> On `connect()`: ensures the `NDK` instance is connected to the configured
> `relays`, then calls
> `ndk.subscribe({ kinds: [<wrap>], '#p': [serverPubkey] }, { closeOnEose: false })`
> and forwards each event's raw bytes to the registered handler. **v0
> connects to `relays[0]` only; v1 dials all entries.**
>
> On `publish()`: deserializes the bytes into an `NDKEvent` and publishes it
> via `event.publish()`. Reconnection and retry are handled internally by NDK.

```typescript
import NDK from '@nostr-dev-kit/ndk'
import type { KindSet } from '@nostr-tun/core'
import { KINDS_NOSTR_TUN } from '@nostr-tun/core'

class NdkRelayAdapter implements RelayPort {
  constructor(
    private ndk: NDK,
    private serverPubkey: string,
    private kinds: KindSet = KINDS_NOSTR_TUN,
  )
  connect(): Promise<void>
  onEvent(handler: (rawEvent: Uint8Array) => void): void
  publish(event: Uint8Array): Promise<void>
  disconnect(): Promise<void>
}
```

The subscription filter is built as `{ kinds: [kinds.wrap], '#p': [serverPubkey] }`.

### `InMemoryStorageAdapter`

> Implements `StoragePort` using a plain JavaScript Map.
> Returns null for missing or expired keys. No persistence across restarts.
> `setIfAbsent` is implemented as a `Map.has` check followed by `Map.set` —
> safe because Node/Bun/browser JavaScript is single-threaded per event-loop
> tick, so the read-then-write pair cannot interleave.

```typescript
class InMemoryStorageAdapter implements StoragePort {
  private store: Map<string, CorrelationEntry>
  setIfAbsent(id: string, entry: CorrelationEntry): Promise<boolean>
  set(id: string, entry: CorrelationEntry): Promise<void>
  get(id: string): Promise<CorrelationEntry | null>
  delete(id: string): Promise<void>
}
```

### `HonoAdapter`

> Implements HttpPort for the Hono framework.
>
> `toRequest()`: constructs a standard Web API Request from NostrRequest
> fields. Always injects the caller's identity into the
> **`x-nostr-tun-principal`** request header (value = `nostrRequest.principal`,
> i.e. the client's real Nostr pubkey hex). Handlers read this header to
> authenticate the caller; absence means the request arrived over plain
> HTTP and should be treated as anonymous.
>
> `toNostrResponse()`: reads status, headers, and body bytes from the Hono Response
> and packages them into a NostrResponse with the original Correlation ID.

```typescript
class HonoAdapter implements HttpPort {
  toRequest(nostrRequest: NostrRequest): Request
  toNostrResponse(id: string, response: Response): Promise<NostrResponse>
}
```

**Spoofing-safety contract:** when the same handler is mounted for both
HTTP and Nostr (the common case — see Server Usage Example), `nostr-tun.route()`
**must strip any inbound `x-nostr-tun-principal` header from plain HTTP
requests before they reach the handler**. Otherwise an external HTTP caller
could forge an arbitrary pubkey identity by setting the header itself. The
Nostr path overwrites the header from the verified `seal.pubkey`, so it is
trustworthy on that path; the HTTP path has no such verification, so the
header must be absent.

---

## CorrelationManager (`server/src/correlation-manager.ts`)

> Owns the full lifecycle of a single request-response round trip on the
> server: registers an inbound request after the inbound event has been
> decoded by `CryptoPort.unwrapRequest`, and resolves the stored entry
> when the handler's response is ready to publish (so the reply can be
> addressed to the original caller via `principal`). Depends only on the
> server-owned `StoragePort`. Has no knowledge of relay, crypto, or HTTP.
>
> Client-side correlation is **not** done here — `NostrTunClient` keeps
> its own in-memory map of pending `Promise` resolvers, which cannot
> live behind `StoragePort` (resolvers aren't serializable).

```typescript
class CorrelationManager {
  constructor(private storage: StoragePort) {}

  // Called when an inbound request is received.
  // Atomically stores the principal and expiry via `storage.setIfAbsent`.
  // Returns `true` for a fresh request, `false` when the same Correlation ID
  // is already in flight — in which case the orchestrator MUST drop the
  // event without invoking the handler. This makes the server idempotent
  // against relay re-delivery (v0 single relay) and multi-relay fan-out (v1).
  async register(request: NostrRequest): Promise<boolean>

  // Called when the handler's response is ready.
  // Returns the stored entry if the ID is known and not expired, otherwise null.
  // Deletes the entry after retrieval — one response per request.
  async resolve(id: string): Promise<CorrelationEntry | null>

  // Removes all entries whose expiresAt is in the past.
  // Intended to be called on a periodic timer.
  async evictExpired(): Promise<void>
}
```

---

## Public API — `NostrTun`

> The composition root of `@nostr-tun/server`, located at
> `packages/server/src/app/nostr-tun.ts`. Wires all ports together.

```typescript
class NostrTun {
  constructor(config: NostrTunConfig)
  useRelay(adapter: RelayPort): this
  useCrypto(adapter: CryptoPort): this      // CryptoPort from @nostr-tun/core
  useStorage(adapter: StoragePort): this    // StoragePort from @nostr-tun/server
  useHttp(adapter: HttpPort): this

  // Connects to the configured relay(s), starts the inbound event loop,
  // and starts the TTL eviction timer.
  connect(): Promise<void>

  // Per-route opt-in middleware. Mounted on a Hono route, it serves two
  // roles simultaneously:
  //   (1) Mount marker — `manifest()` enumerates routes carrying this
  //       middleware into `/.well-known/nostr-tun.json`.
  //   (2) Runtime gatekeeper — when an inbound Nostr-decoded request
  //       reaches the Hono dispatcher, only routes whose chain includes
  //       this middleware are permitted to invoke the handler. Routes
  //       without it return 501 + x-nostr-tun-error: route-not-enabled.
  // Plain HTTP requests pass through untouched.
  route(): MiddlewareHandler

  // Hono middleware that injects the `Nostr-Tun-Location` response header
  // (origin-level advertisement) on every response that flows through it.
  // Mount with `app.use('*', tunnel.advertise())` to advertise on all
  // responses, or scope to specific routes/methods if desired.
  // The header value is built from the constructor's `pubkey` + `relays` +
  // `advertiseTtl`. Plain-HTTP-only deployments simply omit this call.
  advertise(): MiddlewareHandler

  // Hono handler that emits the auto-generated capability manifest.
  // Mount with `app.get('/.well-known/nostr-tun.json', tunnel.manifest())`.
  // At request time, it walks the Hono app's route table and includes only
  // routes whose middleware chain contains `route()` (identity-checked via
  // an internal symbol marker). The route list therefore tracks the code
  // exactly — drift is impossible by construction.
  manifest(): Handler

  disconnect(): Promise<void>
}

type NostrTunConfig = {
  relays: string[]      // wss:// URLs. v0 uses relays[0] only; v1 dials all.
  secretKey: string     // Server's Nostr secret key (hex)
  ttl: number           // Seconds before a pending correlation entry expires
  advertiseTtl?: number // Seconds for `Nostr-Tun-Location` ma= and manifest ttl.
                        // Defaults to 300.
}
```

---

## Server Usage Example

```typescript
import NDK, { NDKPrivateKeySigner } from '@nostr-dev-kit/ndk'
import {
  NostrTun,
  NdkRelayAdapter,
  HonoAdapter,
  InMemoryStorageAdapter,
} from '@nostr-tun/server'
import { NdkCryptoAdapter } from '@nostr-tun/ndk-adapters'
import { Hono } from 'hono'

const relays = ['wss://relay.example.com']
const signer = new NDKPrivateKeySigner(process.env.SERVER_SECRET_KEY!)
const ndk = new NDK({ explicitRelayUrls: relays, signer })
const serverPubkey = (await signer.user()).pubkey

// Kinds default to KINDS_NOSTR_TUN if omitted.
// import { KINDS_NIP80 } from '@nostr-tun/core'
// const kinds = KINDS_NIP80     // ← opt into the NIP-80 draft

const tunnel = new NostrTun({
  relays,
  secretKey: process.env.SERVER_SECRET_KEY!,
  ttl: 120,
})
  .useRelay(new NdkRelayAdapter(ndk, serverPubkey /*, kinds */))
  .useCrypto(new NdkCryptoAdapter(ndk /*, kinds */))
  .useStorage(new InMemoryStorageAdapter())
  .useHttp(new HonoAdapter())

await tunnel.connect()

const app = new Hono()

// Advertise NostrTun on every HTTPS response (sets `Nostr-Tun-Location` header).
// Optional — omit if you only want clients with out-of-band knowledge to
// reach the Nostr endpoints.
app.use('*', tunnel.advertise())

// Auto-generated capability manifest. Lists every route below that has
// `nostr-tun.route()` mounted — derived from the Hono route table at request
// time. Operators never write this list by hand.
app.get('/.well-known/nostr-tun.json', tunnel.manifest())

// Plain HTTP only — not exposed via Nostr; absent from the manifest.
app.post('/v1/mint/quote', mintQuoteHandler)

// HTTP + Nostr — same handler, both transports.
// Listed in the manifest as { method: "POST", path: "/v1/mint/quote" }.
app.post('/v1/mint/quote', tunnel.route(), mintQuoteHandler)

// Pick the runtime adapter for your deployment:
import { serve } from '@hono/node-server'
serve({ fetch: app.fetch, port: 3000 })

// Bun:         Bun.serve({ fetch: app.fetch, port: 3000 })
// Workers:     export default { fetch: app.fetch }
// Vercel/Edge: export default app.fetch
```

---

---

# @nostr-tun/client

> fetch()-compatible Nostr client SDK.
> Resolves server info, wraps requests in Gift Wrap, and returns standard Response objects.
> Depends on `@nostr-tun/core`, `@nostr-tun/ndk-adapters`, and `@nostr-dev-kit/ndk`.
> NDK symbols appear only inside `adapters/` or come from `@nostr-tun/ndk-adapters`.

---

## Ports

> `CryptoPort` is **imported from `@nostr-tun/core`**. The ports below are
> client-only. The client deliberately does **not** define a `StoragePort`:
> its in-flight state is a map of pending `Promise` resolvers, which
> cannot be persisted in any external KV. See `NostrTunClient` below.

### `TransportPort`

> Defines how the client sends and receives raw Nostr events.
> Symmetric with the server's `RelayPort`. **Crypto-agnostic by design** —
> decryption and Correlation ID matching are the orchestrator's (`NostrTunClient`)
> concern, not this port's. This keeps `CryptoPort` and `TransportPort`
> independently swappable.

```typescript
interface TransportPort {
  // Opens the connection(s) and subscribes to inbound events addressed to
  // the caller's pubkey. Resolves once the subscription is active.
  connect(): Promise<void>

  // Registers a callback fired for every matching inbound event.
  // Raw event bytes are passed as-is; the orchestrator unwraps them.
  onEvent(handler: (rawEvent: Uint8Array) => void): void

  // Publishes a signed, encrypted event.
  publish(event: Uint8Array): Promise<void>

  // Closes the underlying connection(s) gracefully.
  disconnect(): Promise<void>
}
```

### `DiscoveryPort` (extension point)

> Optional. Plug here to consult an **external** discovery strategy
> (NIP-05, DNS TXT, hand-rolled directory, etc.) when an origin's
> `ServerInfo` is not already known to `NostrTunClient` from a pinned
> config or from in-band `Nostr-Tun-Location` learning.
>
> No concrete implementations ship in `@nostr-tun/client` — see
> `NOSTR_TUN_DISCOVERY.md` for adapters and grammars. The interface is
> defined here so the resolution chain inside `NostrTunClient` has a
> single, stable hook.

```typescript
interface DiscoveryPort {
  // Resolves ServerInfo from a given origin (scheme + host + optional port).
  // Returns null if no record is found.
  resolve(origin: string): Promise<ServerInfo | null>
}
```

`NostrTunClient` consults this *after* its pinned-origin map and *before*
falling back to plain HTTPS + `Nostr-Tun-Location` learning — see the
resolution order in the `NostrTunClient` section below.

---

## Adapters

> `NdkCryptoAdapter` is **not** defined here — it is imported from
> `@nostr-tun/ndk-adapters` (single source of truth, shared with the server).

### `NdkTransportAdapter`

> Implements TransportPort using NDK.
>
> On `connect()`: ensures the NDK instance is connected to the target relay(s)
> and opens a `ndk.subscribe({ kinds: [1059], '#p': [clientPubkey] })` with
> `closeOnEose: false`, forwarding each event's raw bytes to the registered
> handler.
>
> On `publish()`: deserializes the bytes into an `NDKEvent` and calls
> `event.publish()`. Reconnect/retry is handled internally by NDK.
>
> Adapter holds **no crypto state** — no `CryptoPort` dependency, no secret key.

```typescript
import NDK from '@nostr-dev-kit/ndk'
import type { KindSet } from '@nostr-tun/core'
import { KINDS_NOSTR_TUN } from '@nostr-tun/core'

class NdkTransportAdapter implements TransportPort {
  constructor(
    private ndk: NDK,
    private clientPubkey: string,
    private kinds: KindSet = KINDS_NOSTR_TUN,
  )
  connect(): Promise<void>
  onEvent(handler: (rawEvent: Uint8Array) => void): void
  publish(event: Uint8Array): Promise<void>
  disconnect(): Promise<void>
}
```

The subscription filter is built as `{ kinds: [kinds.wrap], '#p': [clientPubkey] }`.

> No `DiscoveryPort` adapter ships in `@nostr-tun/client` — see
> `NOSTR_TUN_DISCOVERY.md` for NIP-05 / DNS TXT / custom directory
> implementations. The default NostrTun discovery flow uses in-band
> `Nostr-Tun-Location` learning, which is built into `NostrTunClient`
> directly (no port adapter needed).

---

## Public API — `NostrTunClient`

> The composition root of `@nostr-tun/client`, located at
> `packages/client/src/app/nostr-tun-client.ts`. Exposes a `fetch()`-compatible
> interface and acts as a **dual-mode dispatcher**: every call goes either
> over Nostr (when the origin is known to be NostrTun-capable for the target
> path) or over plain HTTPS (otherwise — which doubles as the in-band
> learning channel).
>
> Internally maintains two stores:
>   - **Origin cache**: `Map<origin, { pubkey, relays, manifest, expiresAt }>`.
>     Populated by pinning, by `DiscoveryPort` resolution, or by parsing
>     the `Nostr-Tun-Location` header from HTTPS responses (and then fetching
>     `/.well-known/nostr-tun.json`).
>   - **Pending-request map**: `Map<id, { resolve, reject, expiresAt }>` for
>     outstanding Nostr round-trips. The TTL timer and Correlation ID
>     matching live here — **not** inside the transport adapter, and **not**
>     behind a `StoragePort` (resolver functions are not serializable).

### Per-call resolution order

For each `fetch(url, init)`:

1. **Pinned?** — origin appears in the pin map (set via `pin()`). Use those
   `{ pubkey, relays }` directly; no manifest required for pinned origins
   (caller has accepted the contract out-of-band).
2. **Cached?** — origin appears in the in-band cache and not expired. Use
   the cached `pubkey + relays`. If a manifest is present, check whether
   `(method, path)` is registered:
   - **Hit** → Nostr path.
   - **Miss** → plain HTTPS for this call, mark `(origin, method, path)`
     as Nostr-disabled in the cache.
3. **External `DiscoveryPort` provided?** — call `discovery.resolve(origin)`.
   On success, populate cache and proceed as in (2).
4. **Fall back to HTTPS** — perform a plain `fetch()`. After the response
   arrives, scan headers for `Nostr-Tun-Location`:
   - **Present** → parse, populate cache, kick off a background fetch of
     `/.well-known/nostr-tun.json` to populate the route list. Subsequent
     calls to this origin can take the Nostr path.
   - **Absent** → cache the negative result (origin is not NostrTun-aware)
     for a short interval to avoid re-checking on every call.
5. **Runtime safety net** — if the Nostr path returns
   `501 + x-nostr-tun-error: route-not-enabled`, mark the path as
   Nostr-disabled, retry transparently via plain HTTPS, and trigger a
   manifest refresh.

```typescript
class NostrTunClient {
  constructor(config: NostrTunClientConfig)
  useTransport(adapter: TransportPort): this
  useCrypto(adapter: CryptoPort): this           // CryptoPort from @nostr-tun/core
  useDiscovery(adapter: DiscoveryPort): this     // optional — external strategy

  // Pre-seed the origin cache with a known server. Bypasses HTTPS-first
  // bootstrap entirely for that origin: every call goes straight to Nostr
  // using the supplied pubkey + relays. Use when the caller already trusts
  // the binding out-of-band (e.g., bundled in app config, manually copied
  // from a known operator).
  //
  // Pinned origins are not subject to the manifest check — the caller has
  // implicitly opted into "all paths via Nostr". A 501 response still
  // triggers the runtime fallback for that path only.
  pin(origin: string, info: ServerInfo): this

  // Drop-in replacement for the global fetch(). Routes through Nostr when
  // possible per the resolution order above; otherwise plain HTTPS.
  fetch(url: string, init?: RequestInit): Promise<Response>
}

type NostrTunClientConfig = {
  secretKey: string   // Client's Nostr secret key (hex)
  ttl: number         // Seconds to wait for a response before rejecting

  // Whether to learn from `Nostr-Tun-Location` headers on HTTPS responses
  // and auto-switch subsequent calls to Nostr. Defaults to `true`.
  // Set `false` to disable in-band learning (only `pin()` and the optional
  // DiscoveryPort populate the origin cache).
  learnFromAdvertisement?: boolean
}
```

---

## Client Usage Example

```typescript
import NDK, { NDKPrivateKeySigner } from '@nostr-dev-kit/ndk'
import {
  NostrTunClient,
  NdkTransportAdapter,
} from '@nostr-tun/client'
import { NdkCryptoAdapter } from '@nostr-tun/ndk-adapters'

const clientSecretKey = /* hex */
const signer = new NDKPrivateKeySigner(clientSecretKey)
const clientPubkey = (await signer.user()).pubkey

// Relay URL is resolved lazily per origin (from `Nostr-Tun-Location` header
// or pinned config); the NDK instance is reused across origins and adds
// relays on demand.
const ndk = new NDK({ signer })
await ndk.connect()

// Kinds default to KINDS_NOSTR_TUN if omitted.
// import { KINDS_NIP80 } from '@nostr-tun/core'
// const kinds = KINDS_NIP80

const client = new NostrTunClient({
  secretKey: clientSecretKey,
  ttl: 120,
  // learnFromAdvertisement: true,    // ← default; HTTPS-first auto-upgrade
})
  .useTransport(new NdkTransportAdapter(ndk, clientPubkey /*, kinds */))
  .useCrypto(new NdkCryptoAdapter(ndk /*, kinds */))

// (Optional) Skip the HTTPS bootstrap for a known server — go straight to
// Nostr from the first call. Useful when pubkey/relays are bundled in
// app config or a trusted directory.
// client.pin('https://zappy.kr', {
//   pubkey: 'abc123…',
//   relays: ['wss://r1.example.com'],
// })

// Drop-in for fetch() — caller is unaware of Nostr.
// First call to a new origin: plain HTTPS, learn from `Nostr-Tun-Location`,
// fetch manifest in the background.
// Subsequent calls: Nostr (provided the path is in the manifest); HTTPS
// fallback for paths the manifest doesn't expose, or on 501 + x-nostr-tun-error.
const res = await client.fetch('https://zappy.kr/v1/mint/quote', {
  method: 'POST',
  body: JSON.stringify({ amount: 1000 }),
  headers: { 'content-type': 'application/json' },
})

const data = await res.json()
```

---

---

## Scope

### v0 — Minimum viable round-trip

Goal: a client can call `client.fetch(url)` against a NostrTun-enabled Hono
server over a single Nostr relay, end-to-end, with the correct wire format.

| Feature | Package | Backed by |
|---|---|---|
| Relay connect + subscribe (single relay) | server / client | NDK relay pool |
| NIP-44 + NIP-59 Gift Wrap (kind 21910 / 21911) | server / client | NDK NIP-44 + `NDKEvent` |
| Event signing | server / client | `NDKPrivateKeySigner` |
| Correlation ID matching (server, via `CorrelationManager`) | server | — (pure) |
| Correlation ID matching (client, via in-memory pending map) | client | — (pure) |
| TTL eviction | server / client | — (pure) |
| Per-route opt-in Hono middleware (mount marker + runtime gatekeeper) | server | — |
| `Nostr-Tun-Location` advertise middleware | server | — |
| `/.well-known/nostr-tun.json` auto-generated manifest | server | Hono route table |
| `501 + x-nostr-tun-error` runtime fallback | server | — |
| Direct connection (`pin(origin, info)`) | client | — |
| HTTPS-first in-band learning + auto-switch | client | — |
| Manifest-aware per-route dispatch + HTTPS fallback | client | — |
| `fetch()`-compatible client API | client | — |
| In-memory `StoragePort` adapter | server | — |

**Explicitly out of v0:** chunking, multi-relay, persistent storage, HTTP fallback.
A payload that exceeds NIP-44 size limits is rejected by v0.

---

### v1 — Scale, resilience, and transport options

Goal: production readiness. Everything in v1 is additive — no v0 port
contracts change.

| Feature | Package | Backed by | Rationale |
|---|---|---|---|
| Chunk split / reassembly | core | — | Bypass NIP-44 size cap for large payloads |
| Multi-relay HA | server + client | NDK multi-relay pool | Availability + dedup by Correlation ID |
| Redis `StoragePort` adapter | server | `ioredis` (or equivalent) | Correlation state survives restart / horizontal scale |

**Why these v0 limits become problems**

- **Chunking:** NIP-44 has a hard per-event ciphertext size cap (~64 KB after
  padding). v0 rejects payloads above this ceiling outright. Real APIs
  regularly exceed it (file uploads, bulk responses, images as base64), so v1
  needs a split/reassembly layer at the domain level — the crypto port and
  transport port stay size-agnostic.

- **Multi-relay:** v0 assumes a single relay URL. If that relay hiccups or
  rate-limits, every in-flight request fails. v1 broadcasts to multiple relays
  and the client deduplicates by Correlation ID (first matching response wins).

- **Redis `StoragePort`:** v0's `InMemoryStorageAdapter` keeps `CorrelationEntry`
  in a per-process JavaScript `Map`. Two operational scenarios break this:
  - **Restart.** If the server restarts with requests in flight, the map is
    wiped. Responses that arrive a few seconds later have no matching entry
    and get dropped — the caller sees a TTL timeout even though the handler
    actually ran.
  - **Horizontal scale (N > 1 server instances).** A Nostr relay fans every
    matching event out to every active subscription. A request that instance A
    accepted may have its response delivered to instance B's subscription.
    B's local map has no entry for that Correlation ID, so the response is
    discarded. The request cannot be correctly routed back to its caller.
  Both failures share one root cause: correlation state is process-local. A
  shared, TTL-aware key/value store (Redis being the lightest option) resolves
  both. Postgres / DynamoDB / any equivalent that implements `StoragePort`
  works identically — Redis is just the smallest viable choice.

  For Redis, `setIfAbsent` maps to a single `SET key value NX EX <ttl>`
  command, which is natively atomic across instances — so multi-instance
  idempotency (an inbound event arriving on instance B for a request that
  instance A already accepted) is handled by Redis without extra locking.

**Migration from v0 → v1:** swap adapters at the composition root only.
Application code using `NostrTun` / `NostrTunClient` does not change.

---

## Extension Points

- **External discovery strategies (NIP-05, DNS TXT, custom directories):** Implement `DiscoveryPort` and inject via `NostrTunClient.useDiscovery(...)`. See `NOSTR_TUN_DISCOVERY.md` (separate doc) for the catalog of strategies and their wire formats. Core protocol does not change.
- **Chunk support (v1):** Add `chunk` field to `NostrRequest`/`NostrResponse` in `@nostr-tun/core` and bump `capabilities.chunking` to `true` in the manifest. Port contracts do not change — only the server's `CorrelationManager`, the client's pending-request map, and the crypto adapters grow.
- **Multi-relay (v1):** NDK already supports multi-relay pools; upgrade simply means passing multiple `explicitRelayUrls` to the `NDK` instance that backs `NdkRelayAdapter` / `NdkTransportAdapter`. Port contracts unchanged.
- **HTTP fallback transport (v1):** Add `HttpTransportAdapter` to `@nostr-tun/client` implementing `TransportPort`. Has no NDK dependency. Client code does not change — only the injected adapter swaps. (Independent of the existing HTTPS-first dispatcher in `NostrTunClient`, which always uses the platform `fetch`.)
- **Alternate Nostr library:** Replace `Ndk*` adapters with ones built on `nostr-tools` or another library. Core, ports, `NostrTun`, and `NostrTunClient` do not change.
- **Rust port:** Each port interface maps to a Rust trait. Each adapter becomes a struct (backed by `nostr-sdk` or similar). Core maps to a Tokio task. The hexagonal boundary makes the translation mechanical.
