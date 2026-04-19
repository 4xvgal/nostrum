# Nostrum — Milestones

## v0 — shipped

Five vertical slices, each leaving the codebase testable end-to-end:

1. **Foundation** — monorepo, `@nostrum/core` types & ports,
   `NdkCryptoAdapter`, round-trip unit tests.
2. **Server MVR** — `RelayPort`, `HttpPort`, `StoragePort`,
   `CorrelationManager`, `Nostrum` composition root with `route()`
   middleware and `connect()/disconnect()` lifecycle.
3. **Client MVP (pin-only)** — `TransportPort`, `NostrumClient` with
   pending map, TTL timers, correlation matching; full round-trip vs
   the Phase 2 server.
4. **Discovery & HTTPS-first** — `advertise()`, `manifest()`,
   `Nostrum-Location`, origin cache, manifest-driven routing.
5. **Robustness** — 501 fallback + negative cache, TTL eviction on
   both sides, spoofing defense for `x-nostrum-principal`, strict mode.

Post-v0 increments:

- `@nostrum/nostr-tools-adapters` drop-in. Bench 872 → 37 ms local /
  ~300 ms remote. NDK adapters relocated to `@nostrum/ndk-adapters`;
  `nostr-tools` is the default, NDK opt-in via
  `NOSTRUM_ADAPTERS=ndk`. See `NOSTRUM_PERFORMANCE.md`.
- Fast-fail on `["OK", id, false, …]` via
  `TransportPort.onPublishError?`. Rejects pending with
  `PublishRejectedError` instead of waiting out the 30 s TTL.

---

## v1 — next

Rough priority order. Each item is independent and can ship on its
own; specifics live in the linked docs where present.

### Privacy — size padding + decoy tags
Adapter-level, latency-neutral metadata hardening. Details in
[`NOSTRUM_PRIVACY.md`](NOSTRUM_PRIVACY.md).

### Multi-relay fanout
Publish and subscribe across N relays simultaneously; dedup by outer
event id. Fits entirely inside the `RelayPort` / `TransportPort`
adapter layer, no core changes. Gives failover, observation
diffusion, and a race-to-first-response latency bonus as a side
effect.

### Session mode (P4 from the perf doc)
Full gift wrap on the first request; server hands back `session_id`
+ AEAD key in the encrypted response. Subsequent requests use a
single-layer event with a session-scoped ephemeral signer and AEAD
payload. Trades a small forward-secrecy window for ~10× server
throughput and cheaper mobile battery. Requires `KindSet` extension
(`sessionMessage?`) and a new `SessionPort` on the server.

### Chunking for payloads above NIP-44 limit
Currently a single wrap carries one rumor. Large bodies need a split
scheme (fragment index + total count in the rumor tags, reassembly
keyed by correlation id on the receiver). Scope mostly lives in
`CryptoPort` / `NostrumClient` / `Nostrum`; port interfaces stay the
same.

### Shared-KV `StoragePort` adapter
Redis or similar, so horizontally scaled servers share correlation
state. Drop-in replacement for `InMemoryStorageAdapter`.

### `DiscoveryPort` implementations
NIP-05, DNS TXT, or a curated directory resolver. The port already
exists as an extension point; v1 ships at least one real adapter.
See [`NOSTRUM_DISCOVERY.md`](NOSTRUM_DISCOVERY.md).

### HTTP fallback `TransportPort`
For environments where WebSocket is blocked but HTTPS gets through.
Long-polling or SSE against a relay gateway. Lower priority —
depends on demand.

---

## Explicitly deferred beyond v1

- Tor / I2P / mix-network transport adapters (doable as drop-in
  `TransportPort`, but latency cost rules them out of the core
  roadmap; see `NOSTRUM_PRIVACY.md` non-goals).
- Onion-wrapped event chains through multiple relays — would require
  a custom relay network; a real mixnet is cheaper.
- Forward-secrecy beyond session keys (Double Ratchet).

## Phase dependency (v1 only)

```
  privacy       ─┐
  multi-relay   ─┼─  independent, any order
  chunking      ─┘
  session mode   ──► needs chunking handy for larger AEAD payloads
  shared-KV storage  ──► needs multi-relay for HA payoff
  discovery adapters  ──► no deps, can land any time
  HTTP fallback       ──► no deps
```
