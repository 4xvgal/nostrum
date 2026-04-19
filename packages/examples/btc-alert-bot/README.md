# btc-alert-bot

Reference example: a BTC price bot whose **management API** is reachable
only over Nostr (via `@nostr-tun/server`). Alerts (±N% moves) are
delivered as **Nostr DMs** (kind 4) to the pubkey that registered.

- **Server**: Hono + `NostrTun`, CoinGecko poller, NIP-98 auth for
  writes, DM publisher. No public IP / DNS / TLS required.
- **Web**: TUI-styled PWA (Vite + Preact + plain CSS). Uses
  `NostrTunClient` directly from the browser.

Both sides default to **public Nostr relays** — no local relay needed.
The client finds the bot **by pubkey alone** (no relay URL configured on
the client): the server publishes a kind-31910 service announcement to a
small bootstrap set, and the PWA looks it up there.

## Layout

```
server/
  src/        Hono + NostrTun, price poller, alert dispatcher
  scripts/
    gen-keys.ts   — generate the bot's keypair (hex + nsec/npub)
web/
  src/        TUI-styled PWA
```

## Run

```bash
# 0. Install (repo root)
bun install

# 1. Generate the bot's keypair. Writes BOT_SECRET_KEY to server/.env.
cp packages/examples/btc-alert-bot/server/.env.example \
   packages/examples/btc-alert-bot/server/.env
bun --cwd packages/examples/btc-alert-bot/server run gen-keys:env

# 2. Boot the server. Public relay is wss://nostr.vulpem.com by default.
bun --cwd packages/examples/btc-alert-bot/server run dev
# → prints the bot's hex pubkey; copy it.

# 3. Point the PWA at the bot pubkey.
cp packages/examples/btc-alert-bot/web/.env.example \
   packages/examples/btc-alert-bot/web/.env.local
# edit VITE_SERVER_PUBKEY= <the hex pubkey from step 2>

# 4. Boot the PWA.
bun --cwd packages/examples/btc-alert-bot/web run dev
# → http://localhost:5173
```

Swap `RELAY_URL` / `VITE_RELAY_URL` to any public relay you like
(`wss://relay.damus.io`, `wss://nos.lol`, `wss://relay.nostr.band`, …).
The server and PWA just need to agree on the same relay.

## Identity model

- **Tunnel keys** (ephemeral, per-request): confidential RPC envelope.
  Unrelated to user identity.
- **Notify pubkey**: the user's long-lived Nostr pubkey. Server stores
  `(notify_pubkey → subscription)` and delivers DMs here.
- **NIP-98 auth header** (`Authorization: Nostr <base64(event)>`): proves
  ownership of the notify pubkey for write endpoints. No opaque tokens.

## Discovery (kind-31910)

The server publishes a parameterized-replaceable **kind 31910** event to
the bootstrap relays on boot and every 10 minutes thereafter:

```
kind    = 31910
pubkey  = <bot hex>
tags    = [
  ['d', 'nostr-tun'],
  ['relay', 'wss://relay.damus.io'],
  ['alt', 'nostr-tun service manifest'],
]
content = '{"version":"0.1","ttl":60,"capabilities":{...},"routes":[...]}'
```

The PWA resolves the bot by fan-querying the bootstrap set for this
event, picks the most-recent, and reads its relay / routes / capabilities
from the signed payload. No HTTPS endpoint is ever contacted by the
client.

## Endpoints

| Method | Path                     | Auth   | Body                                 |
|--------|--------------------------|--------|--------------------------------------|
| GET    | `/v1/price`              | —      | —                                    |
| POST   | `/v1/subscribe`          | NIP-98 | `{ threshold_pct, direction, window_sec }` |
| GET    | `/v1/subscriptions`      | NIP-98 | —                                    |
| DELETE | `/v1/subscribe/:id`      | NIP-98 | —                                    |

## Known limitations

- In-memory subscription store (resets on restart).
- No rate limit — add one before exposing to a public relay in production.
- PWA does not receive DMs in real time while closed; it drains unseen
  DMs on next open. Background Web Push is out of scope for the PoC.
