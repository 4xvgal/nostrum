# AGENTS.md

Hexagonal architecture rules for the Nostrum monorepo. See
`NOSTRUM_DESIGN.md` for full context, `NOSTRUM_MILESTONES.md` for plan.

Packages: `@nostrum/core`, `@nostrum/ndk-adapters`, `@nostrum/server`,
`@nostrum/client`.

---

## Rules

### R1 — Dependency direction is always inward

`core/types/` imports nothing. `core/ports/` imports only `core/types/`.
Domain logic (e.g. `CorrelationManager`) imports core + its own ports.
Adapters sit outside the hexagon and depend inward.

Package-level graph is acyclic:

```
core  ◄─  ndk-adapters  ◄─  server
                         ◄─  client
```

`@nostrum/server` and `@nostrum/client` never import each other.

### R2 — Domain purity

`@nostrum/core` has zero external deps.
- No `@nostr-dev-kit/ndk`, `hono`, or runtime-specific imports.
- No network, filesystem, or top-level `await`.
- No SDK types (`NDKEvent`, `NDKFilter`, …) in `core/` type definitions.

If a function needs I/O, it goes behind a port. If a type references an
SDK, it belongs in an adapter.

### R3 — Port neutrality

Ports describe **what** the hexagon needs, not **how** an SDK provides it.

| Bad | Good |
|-----|------|
| `publishNDKEvent(event: NDKEvent)` | `publish(event: Uint8Array)` |
| `NDKFilter` as a port parameter | Adapter builds the filter internally |
| `ndk: NDK` on a port method | Adapter holds NDK; port has no knowledge |
| `relays: string[]` on every port call | Adapter resolves relays from its own config |
| Protocol-specific names (`giftWrapSend`) | Generic names (`publish`, `wrap`) |

### R4 — Composition root is the only boundary crosser

Only `packages/server/src/app/nostrum.ts` (`Nostrum`) and
`packages/client/src/app/nostrum-client.ts` (`NostrumClient`) may import
adapters *and* ports *and* domain in the same file. They construct
adapters, inject them via `use*()` methods, and expose the public API.

---

## Import rules

| From | Can import | CANNOT import |
|------|-----------|---------------|
| `core/types/` | nothing | everything |
| `core/ports/` | `core/types/` | any adapter, any SDK |
| `ndk-adapters/*` | `@nostrum/core`, `@nostr-dev-kit/ndk` | `server`, `client`, `hono` |
| `server/ports/`, `server/correlation-manager.ts` | `@nostrum/core`, `server/ports/` | `server/adapters/`, any SDK, `hono` |
| `server/adapters/` | `@nostrum/core`, `server/ports/`, its SDK | `server/app/`, `@nostrum/client` |
| `server/app/` | everything in package, `@nostrum/core`, `@nostrum/ndk-adapters` | `@nostrum/client` |
| `client/ports/` | `@nostrum/core` | `client/adapters/`, `client/app/`, any SDK |
| `client/adapters/` | `@nostrum/core`, `client/ports/`, its SDK | `client/app/`, `@nostrum/server` |
| `client/app/` | everything in package, `@nostrum/core`, `@nostrum/ndk-adapters` | `@nostrum/server` |

---

## Practical invariants

- **SDK symbols** (`NDK`, `NDKEvent`, `NDKPrivateKeySigner`, `NDKFilter`, …) appear only under `ndk-adapters/` or `packages/*/src/adapters/`. Grep outside those paths ⇒ violation.
- **Hono symbols** appear only under `server/adapters/http/` and the `Nostrum` composition root. Never in `core/` or ports.
- **`KindSet` injection:** every adapter touching kind numbers takes `KindSet` as a constructor arg (default `KINDS_NOSTRUM`). Never hardcode kind numbers.
- **Client has no `StoragePort`.** Pending-request map stays in-memory — `Promise` resolvers aren't serializable.
- **Spoofing guard:** `route()` strips inbound `x-nostrum-principal` on plain HTTP before handlers run. The Nostr path re-injects it from verified `seal.pubkey`.
- **Bun is a dev-tool only.** No `Bun.serve`, `Bun.file`, `Bun.sql` in published code. Target standard Web APIs.

---

## When a rule feels wrong

Stop and raise it. Most "exceptions" are a missing port or a misplaced
