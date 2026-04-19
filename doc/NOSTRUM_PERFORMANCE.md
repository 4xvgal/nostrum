# Nostrum — Performance Analysis & Optimization Roadmap

> Latency characterization of Nostrum's v0 stack and a concrete path for
> future optimization. v0 is intentionally un-optimized; the hexagonal
> boundary makes every item below swappable without touching the domain.

---

## Measured baseline

Mean latency per round-trip at different levels of the stack:

| Layer | Latency | Notes |
|---|---|---|
| Raw NIP-44 encrypt/decrypt (primitive) | **~0.12 ms** | Not a bottleneck |
| Gift Wrap construction (rumor → seal → wrap, both sides) | **~35–47 ms** | Acceptable |
| Full client → relay → server → relay → client | **~800 ms** (local nostr-rs-relay) | This is the problem |
| Same, against remote relay | ~1100 ms | Internet adds ~250 ms |

Measured via `scripts/bench.ts` and `scripts/bench-remote.ts`
(see `package.json` smoke/bench scripts).

**Interpretation:**

```
800 ms (end-to-end)
 − 47 ms (gift wrap crypto)
 ──────
~750 ms is relay + NDK pipeline overhead
```

Crypto is **not** the bottleneck. Optimizing NIP-44 or dropping gift wrap
saves 10–20 ms against a ~800 ms budget — imperceptible.

---

## Bottleneck structure

```
Client
  └─ NDK event construction / serialization
  └─ WebSocket send
Relay
  └─ Event parse + Schnorr verify
  └─ Subscription match + fan-out scheduling
  └─ WebSocket send
Server
  └─ NDK subscription receive
  └─ Internal event queue dispatch
  └─ Decrypt (NIP-44)
  └─ Hono handler
  └─ Encrypt response
  └─ Relay publish
Relay
  └─ (same as above, reverse direction)
```

The dominant cost is relay fan-out scheduling + the NDK subscription
pipeline's internal queueing and coalescing behavior. These are indirect
costs — the relay doesn't advertise the delay it introduces, and NDK's
event loop and subscription grouping aren't tuned for one-shot RPC
semantics.

---

## Optimization priorities

### P1 — Replace NDK with `nostr-tools` + direct WebSocket

Largest expected win. NDK is built for long-running social-graph
subscriptions (grouping, caching, profile resolution). None of that helps
request/response RPC.

- Ship a thin `@nostrum/nostr-tools-adapters` package that implements
  `CryptoPort`, `RelayPort`, and `TransportPort` directly on top of
  `nostr-tools` primitives and a raw `WebSocket`.
- Skip NDK's subscription grouping / coalescing — deliver the event to
  the handler the moment it arrives.
- **Estimated savings: 200–400 ms**.
- No core / port changes needed (hexagonal payoff).

#### Update — measured

Implemented as `@nostrum/nostr-tools-adapters`. `scripts/lib/setup.ts`
selects adapters per port via `NOSTRUM_CRYPTO` / `NOSTRUM_RELAY` /
`NOSTRUM_TRANSPORT` (each `ndk|nostr-tools`; default `ndk`), plus a
convenience `NOSTRUM_ADAPTERS=nostr-tools` that sets all three.

Same local `nostr-rs-relay` in Docker, `N=100` iterations, same machine,
same commit, same process lifetime. Mean / p50 / p95 of the Nostr column:

| Crypto | Relay | Transport | mean | p50 | p95 |
|---|---|---|---:|---:|---:|
| ndk | ndk | ndk | 872.8 | 865.5 | 904.3 |
| **nt** | ndk | ndk | 868.8 | 863.7 | 894.1 |
| ndk | **nt** | ndk | 464.0 | 463.9 | 479.7 |
| ndk | ndk | **nt** | 454.7 | 452.8 | 469.4 |
| ndk | **nt** | **nt** | 31.3 | 31.2 | 34.9 |
| **nt** | **nt** | **nt** | 36.7 | 36.7 | 40.0 |

Readings:

- Crypto swap alone saves ~4 ms. Crypto is not the bottleneck, exactly
  as the per-layer microbench predicted.
- Relay-only swap saves ~409 ms; Transport-only swap saves ~418 ms.
  NDK's subscription pipeline contributes **~400 ms per direction, per
  request** — symmetric on client and server.
- Swapping both Relay and Transport (keeping NDK crypto) collapses the
  round-trip to ~31 ms. Adding the nostr-tools crypto swap on top lands
  at ~37 ms — the small delta is within noise.
- At 37 ms we are below the "Physical lower bound (WS × 2 +
  scheduling) ~20–50 ms" target in the table below. P2 (relay
  ephemeral fast path) and P3 are now into microbench territory; P4
  (session mode) becomes the main throughput lever, not P2.

Reproduce:

```
bun run bench                              # NDK baseline
NOSTRUM_ADAPTERS=nostr-tools bun run bench # full swap
NOSTRUM_CRYPTO=nostr-tools   bun run bench # attribute crypto
NOSTRUM_RELAY=nostr-tools    bun run bench # attribute server-side WS
NOSTRUM_TRANSPORT=nostr-tools bun run bench # attribute client-side WS
```

### P2 — Relay signature-verification fast path

The relay still Schnorr-verifies every incoming event on the hot path.
For ephemeral wraps this is wasted work (the key is single-use, signature
is just a protocol nicety).

- Fork `nostr-rs-relay` (or contribute) to split the db-writer queue:
  ephemeral kinds (20000–29999) skip persistence and get fan-out first.
- Optional dedicated filter for Nostrum kinds (1059, 21059, 21910/21911).
- **Estimated savings: 100–200 ms**.
- Out of Nostrum's code — operator-side change.

### P3 — Connection reuse / keep-alive tuning

Investigate NDK's connection management and WebSocket lifecycle during
bursty RPC traffic. Each request ideally reuses a single long-lived
subscription; re-subscribe / reconnect loops compound the fan-out delay.

- Addressed as a side-effect of P1 (direct WebSocket adapter owns its
  connection lifecycle explicitly).
- **Estimated savings: 100 ms+**.

### P4 — Session mode (throughput / battery, not latency)

Once per-request is down to the ~50–100 ms range, Gift Wrap's 10–20 ms of
ECDH + Schnorr work starts to be visible as a fraction of the budget. At
that point a session-key mode pays off.

- First request: full gift wrap; server hands out `session_id` + session
  AEAD key in the encrypted response.
- Subsequent requests: single-layer event with session-scoped ephemeral
  signer + AEAD-encrypted payload. No ECDH, no seal layer.
- Does **not** reduce end-to-end latency under a relay-dominated budget,
  but gives **~10× server throughput** and noticeable mobile battery
  improvement under sustained load.
- Wire format change → requires `KindSet` extension (`sessionMessage?:
  number`) and a new `SessionPort` or `StoragePort` extension on the
  server side.
- Forward-secrecy trade-off: session-key compromise reveals the whole
  session's traffic. Mitigation: short session lifetime (5–15 min) +
  re-handshake. Full FS would require Double Ratchet (out of scope).

---

## Realistic latency targets

Assuming P1 + P2 + P3 land sequentially:

| Phase | End-to-end latency (local relay) |
|---|---|
| v0 today (NDK + unmodified nostr-rs-relay) | 800 ms |
| After P1 (nostr-tools adapter) | ~300–400 ms |
| After P2 (relay ephemeral fast path) | ~150–200 ms |
| After P3 (explicit connection reuse) | ~50–100 ms |
| Physical lower bound (WS × 2 + scheduling) | ~20–50 ms |

Internet-routed relays add RTT on top (typically +50–300 ms depending on
geography). Even with all optimizations, remote-relay traffic will not
drop below the underlying RTT.

---

## Guidance for v0

**Do not optimize now.** v0 is a correctness proof; NDK is fine.

The hexagonal boundary means each priority above is a drop-in adapter
swap:

- P1 → new adapter package (alongside `@nostrum/ndk-adapters`), user
  opts in via `useCrypto`/`useRelay`/`useTransport` at the composition
  root. No changes to `@nostrum/core`, `@nostrum/server`,
  `@nostrum/client`.
- P2 → operator chooses the relay; no code change required on the
  Nostrum side.
- P3 → absorbed into P1's adapter implementation.
- P4 → new crypto/session adapter + `KindSet` extension. Opt-in per
  origin or per call via a `transportMode` config field.

Run `bun run bench` to establish a current-day baseline before starting
any of the above; re-run after each swap to verify the expected savings.
