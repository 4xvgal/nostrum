# Nostrum — Privacy Roadmap

Future metadata-hardening ideas that fit the existing hexagonal
boundary. Scope: **client-side, latency-neutral, adapter-level**.
Transport onion routing (Tor/I2P/mix) is explicitly out of scope.

## Already private

NIP-59 gift wrap hides the client's real pubkey (outer signer is
ephemeral, per request) and the entire request/response payload.

## What still leaks to the relay

- `["p", serverPk]` — recipient identity
- Wrap size — request/response class inference
- Timing — activity patterns
- Relay choice — single-relay observer correlation (addressed by the
  separately-planned multi-relay fanout, not covered here)

## A. Size padding

Pad the rumor to fixed buckets (e.g. 256 / 512 / 1K / 2K / 4K) before
NIP-44 encrypt.

- **Plug**: `CryptoPort.wrap()` in each adapter; optional shared
  `pad-rumor.ts` helper.
- **Hides**: size-based classification.
- **Cost**: bandwidth +30–70%, CPU µs.
- **Latency**: 0.
- **Open**: pick between adding a pad layer on top of NIP-44 or just
  widening NIP-44 v2's own padding buckets.

## D. Decoy recipient tags

Add N−1 fake `["p", decoyPk]` tags alongside the real one. Relay fans
out to all N; only the real recipient's NIP-44 decrypt succeeds (fast
MAC-reject on decoys, ~0.1 ms).

- **Plug**: `CryptoPort.wrap()` grows an optional `decoyPubkeys` arg,
  or `NostrumClient` wires a `DecoyPoolPort`.
- **Hides**: recipient identity; anonymity set = N.
- **Cost**: relay-side bandwidth ×N, per-decoy one failed decrypt.
- **Latency**: 0 on the real path.
- **Open**:
  - Decoy pool source — needs plausible active recipients, ideally
    sampled from recent `kind:1059` `#p` values on the same relay so
    decoys blend in. Stale pools cluster; rotate.
  - N choice — 3–7 looks like a reasonable starting range.

## Explicit non-goals (for this roadmap)

- Tor / I2P / mix network transports (latency cost).
- Server-side sealed-sender broadcast (viable but not a priority).
- Idle cover traffic (revisit if timing analysis becomes a real
  concern for a deployment).
- Onion-wrapped events — Nostr relays don't participate in unwrap, so
  doing it natively means reinventing a mixnet.

## Verification when implemented

- **A**: round-trip smoke unwraps to identical rumor; all wraps on the
  wire sit in one of the chosen buckets; `bun run bench` stays within
  noise of ~37 ms.
- **D**: real recipient succeeds, decoy subscribers receive but fast-
  reject via NIP-44 MAC; `bun run bench` unchanged.
