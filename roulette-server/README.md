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
- Zero-area click targets currently cover `0-00`, `0-1`, `00-3`, and `0-00-2`.

## Tiers

Roulette has one shared room. Each player joins with a level-specific wallet,
max chip, and max direct straight-up bet.

| level | wallet / min bank | max chip | max direct number bet |
| --- | ---: | ---: | ---: |
| Bronze | 5,000 | 500 | 500 |
| Silver | 15,000 | 500 | 1,000 |
| Gold | 30,000 | 1,000 | 2,000 |
| Platinum | 60,000 | 5,000 | 10,000 |
| VIP | 2,000,000 | 25,000 | 100,000 |
| Elite | 7,000,000 | 50,000 | 500,000 |
| Celestial | 10,000,000 | 100,000 | 1,000,000 |

## Phase Loop

`betting (40s)` -> `spinning (8s)` -> `resolving (5s)` -> repeat.

## Files

- `engine.js` - pure logic: wheel, bet normalization, payout resolution
- `RouletteRoom.js` - per-room state and phase loop
- `RoomManager.js` - room registry and quick-join
- `index.js` - Express and WebSocket bootstrap
