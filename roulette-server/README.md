# VurgLife Roulette Server

American roulette. European roulette is deferred for a later table build; the
logic engine still has European helpers so it can be enabled deliberately later.

## Ports

- **3005** - HTTP API (matchmake, browse, config)
- **3006** - WebSocket game server

Override with env vars `ROULETTE_API_PORT` / `ROULETTE_WS_PORT`.

## Run Standalone

```powershell
cd roulette-server
npm install
node index.js
```

Then open `http://localhost:3005/`. The server also serves the client statically.

## Run Behind The Platform

The platform spawns this server as a child process and proxies HTTP/WS to it.

## Current Variant

- **American** - 38 pockets: `0`, `00`, and `1-36`.
- House edge: **5.26%**.
- The 5-number **Basket** bet covers `0-00-1-2-3` and pays **6:1**.

## Tiers

| minBet | maxBet | wallet | tier |
| ---: | ---: | ---: | --- |
| 100 | 500 | 2,500 | standard |
| 1,000 | 5,000 | 25,000 | VIP |
| 5,000 | 25,000 | 120,000 | VIP |
| 10,000 | 50,000 | 250,000 | VIP |
| 50,000 | 250,000 | 1,000,000 | VIP |

VIP gate (`minBet >= 10000`) matches the other VurgLife games.

## Phase Loop

`betting (20s)` -> `spinning (6s)` -> `resolving (5s)` -> repeat.

## Files

- `engine.js` - pure logic: wheel, bet normalization, payout resolution
- `RouletteRoom.js` - per-room state and phase loop
- `RoomManager.js` - room registry and quick-join
- `index.js` - Express and WebSocket bootstrap
