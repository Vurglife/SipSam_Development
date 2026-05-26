# VurgLife Roulette Server

American + European roulette. Single server, `variant` per room.

## Ports

- **3005** — HTTP API (matchmake, browse, config)
- **3006** — WebSocket game server

Override with env vars `ROULETTE_API_PORT` / `ROULETTE_WS_PORT`.

## Run standalone (for testing without the platform)

```
cd roulette-server
npm install
node index.js
```

Then open <http://localhost:3005/> — the server also serves the client statically.

## Run behind the platform

The platform spawns this server as a child process and proxies HTTP/WS to it. See `../PLATFORM_INTEGRATION.md` for the exact vurglife-platform patches.

## Variants

- **European** — 37 pockets (0, 1-36). House edge 2.70%. Implements the *la partage* rule: 0 lands with an even-money bet → half the stake is returned.
- **American** — 38 pockets (0, 00, 1-36). House edge 5.26%. Adds the 5-number **Basket** bet (0-00-1-2-3, pays 6:1).

## Tiers (minBet → walletSize)

| minBet   | maxBet   | wallet     | tier     |
|---------:|---------:|-----------:|----------|
| 100      | 500      | 2,500      | standard |
| 1,000    | 5,000    | 25,000     | VIP      |
| 5,000    | 25,000   | 120,000    | VIP      |
| 10,000   | 50,000   | 250,000    | VIP      |
| 50,000   | 250,000  | 1,000,000  | VIP      |

VIP gate (`minBet >= 10000`) matches the other VurgLife games.

## Phase loop

`betting (20s)` → `spinning (6s)` → `resolving (5s)` → repeat.

## Files

- `engine.js` — pure logic (wheel, bet normalization, payout resolution)
- `RouletteRoom.js` — per-room state + phase loop
- `RoomManager.js` — room registry + quick-join
- `index.js` — Express + WebSocket bootstrap
