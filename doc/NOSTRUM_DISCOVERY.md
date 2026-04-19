# Nostrum — External Discovery Strategies

> Companion document to **NOSTRUM_DESIGN.md**.
> Catalogues *external lookup* adapters that plug into the
> `DiscoveryPort` extension point. These resolve an origin's
> `ServerInfo` (`{ pubkey, relays[] }`) **out-of-band** — independently
> of the in-band Tor-style flow (`Nostrum-Location` header +
> `/.well-known/nostrum.json` manifest) defined in the main spec.
>
> See NOSTRUM_DESIGN.md § *Discovery & Capability Advertisement* for the
> full discovery taxonomy and the in-band mechanism. This doc covers the
> *external* tier only.

---

## When external discovery is worth it

Nostrum's default is HTTPS-first in-band learning — every uncached origin
costs one plain HTTPS round-trip, after which subsequent calls go via
Nostr. That covers most opt-in scenarios with zero extra infrastructure.

External discovery becomes useful when one of these holds:

1. **First-contact privacy matters.** In-band learning leaks the client's
   IP and TLS SNI on the first HTTPS request. NIP-05/DNS lookups can be
   tunneled through Tor or a privacy-respecting resolver to avoid that
   exposure entirely.
2. **The operator does not run HTTPS at all.** Some deployments expose
   Nostr only — there is no HTTPS endpoint to learn from. External
   discovery is the only option.
3. **You're consuming a directory.** A pre-indexed
   `Map<origin, ServerInfo>` (e.g., curated by a community list) can be
   served via a custom `DiscoveryPort` adapter without any per-call
   network I/O.

If none of these apply, the in-band flow is preferred.

---

## `DiscoveryPort` interface (recap)

Defined in `@nostrum/client/src/ports/discovery.port.ts`:

```typescript
interface DiscoveryPort {
  // Resolves ServerInfo from an origin (scheme + host + optional port).
  // Returns null if no record is found.
  resolve(origin: string): Promise<ServerInfo | null>
}
```

`NostrumClient` consults the attached `DiscoveryPort` **after** its
pinned-origin map and **before** falling back to plain HTTPS bootstrap.
See NOSTRUM_DESIGN.md § *Per-call resolution order* for the full chain.

---

## Adapter: `NIP05Adapter`

> Resolves `ServerInfo` by fetching the standard NIP-05 JSON document
> over HTTPS. Reuses existing NIP-05 infrastructure — no new records to
> create if the operator already runs NIP-05 for user identifiers.

### Wire format

```
GET https://<domain>/.well-known/nostr.json?name=_nostr
```

```json
{
  "names": {
    "_nostr": "<hex_pubkey>"
  },
  "relays": {
    "<hex_pubkey>": ["wss://r1.example.com", "wss://r2.example.com"]
  }
}
```

The reserved name `_nostr` is Nostrum's convention for the server's own
identity (distinct from per-user NIP-05 entries that would live under
arbitrary user names). Operators add this alongside any existing NIP-05
user records.

| Field | Required | Notes |
|---|---|---|
| `names._nostr` | yes | Server's hex pubkey. |
| `relays.<pubkey>` | yes | Array of wss URLs. v0 clients use `[0]`; v1 dials all. |

### Adapter

```typescript
class NIP05Adapter implements DiscoveryPort {
  resolve(origin: string): Promise<ServerInfo | null>
}
```

Returns `null` when the endpoint is unreachable, returns non-2xx, or
omits either of the required fields.

---

## Adapter: `DnsTxtAdapter`

> Resolves `ServerInfo` via a DNS TXT record at the `_nostr` subdomain.
> Lower latency than NIP-05 (single DNS query vs HTTPS round-trip) but
> requires DNS provisioning rights, and the lookup is visible to
> recursive resolvers unless DoH/DoT/Tor is used at the transport layer.

### Wire format

```
_nostr.<domain>  TXT  "pubkey=<hex_pubkey> relays=<wss_url>[,<wss_url>...]"

// Single relay
_nostr.zappy.kr  TXT  "pubkey=abc123... relays=wss://relay.example.com"

// Multiple relays (comma-separated, no whitespace inside the relays= value)
_nostr.zappy.kr  TXT  "pubkey=abc123... relays=wss://r1.example.com,wss://r2.example.com"
```

Grammar:
- The TXT string is one or more whitespace-separated `key=value` pairs.
- `pubkey` (hex) and `relays` (comma-separated wss URLs) are required.
- Parsers MUST ignore unknown keys (forward-compatibility for future
  fields like `caps=`, `version=`).
- v0 clients use `relays[0]`; v1 dials all entries and dedups responses
  by Correlation ID.

### Adapter

```typescript
class DnsTxtAdapter implements DiscoveryPort {
  resolve(origin: string): Promise<ServerInfo | null>
}
```

Returns `null` if the record is absent or missing either required field.

**Runtime caveat.** DNS APIs differ wildly across JS runtimes
(`dns/promises` on Node, `Deno.resolveDns` on Deno, browsers have no
direct API and must use DoH). The adapter is expected to either:
- ship runtime-specific implementations, or
- accept a resolver function via constructor injection so callers wire
  in their own DoH client / library of choice.

---

## Decorator: `CachingDiscoveryAdapter`

> Wraps any `DiscoveryPort` with a positive-result cache. Without it,
> every uncached `client.fetch()` performs a fresh DNS or HTTPS lookup —
> adding latency to every first-hit call and loading the discovery
> endpoint needlessly.

```typescript
class CachingDiscoveryAdapter implements DiscoveryPort {
  constructor(
    private inner: DiscoveryPort,
    private ttlSeconds: number = 300,    // 5 minutes by default
  )
  resolve(origin: string): Promise<ServerInfo | null>
}
```

- **Hit (not expired)** → returns cached `ServerInfo` immediately.
- **Miss / expired** → delegates to `inner.resolve()`, caches on success,
  returns the result.
- **Negative results (`null`) are not cached.** A transient DNS outage
  should not poison the cache for the full TTL.
- TTL of `0` short-circuits caching (every call passes through). Useful
  in tests and during development.

---

## Composition with `NostrumClient`

```typescript
import {
  NostrumClient,
  NdkTransportAdapter,
} from '@nostrum/client'
import { NdkCryptoAdapter } from '@nostrum/ndk-adapters'
import {
  NIP05Adapter,
  DnsTxtAdapter,
  CachingDiscoveryAdapter,
} from '@nostrum/discovery'   // companion package — see "Package layout"

const client = new NostrumClient({
  secretKey: clientSecretKey,
  ttl: 120,
})
  .useTransport(new NdkTransportAdapter(ndk, clientPubkey))
  .useCrypto(new NdkCryptoAdapter(ndk))
  // Cache positive lookups for 5 minutes; without this every uncached
  // origin pays one HTTPS round-trip on the first call.
  .useDiscovery(new CachingDiscoveryAdapter(new NIP05Adapter(), 300))
```

### Chain pattern — try multiple strategies in order

If you want DNS first (cheapest), then NIP-05, then fall back to in-band
learning:

```typescript
class ChainDiscoveryAdapter implements DiscoveryPort {
  constructor(private adapters: DiscoveryPort[]) {}

  async resolve(origin: string): Promise<ServerInfo | null> {
    for (const a of this.adapters) {
      const r = await a.resolve(origin)
      if (r) return r
    }
    return null
  }
}

client.useDiscovery(
  new CachingDiscoveryAdapter(
    new ChainDiscoveryAdapter([
      new DnsTxtAdapter(),
      new NIP05Adapter(),
    ]),
    300,
  ),
)
```

When the chain returns `null`, `NostrumClient` proceeds to its in-band
HTTPS bootstrap — so external strategies are *additive*, not exclusive.

---

## Package layout

These adapters do **not** live in `@nostrum/client`. That package only
ships the `DiscoveryPort` interface and the in-band flow. Two viable
distribution shapes:

- **Single companion package** `@nostrum/discovery` — bundles all three
  adapters. Smallest dependency footprint for callers using more than
  one. Recommended starting shape for v0.
- **One package per strategy** (`@nostrum/discovery-nip05`,
  `@nostrum/discovery-dns`, …) — better tree-shaking and lets each
  package declare its own runtime-specific peer deps. Worth considering
  if `DnsTxtAdapter` ends up needing platform shims that NIP-05 doesn't.

The shape is an implementation decision, not a protocol concern — clients
written against `DiscoveryPort` work with either layout.
