# Tetris boot blob

A one-file Tetris game for the Xahau PWA bootloader
([xahaud PR 793](https://github.com/Xahau/xahaud/pull/793)). The ledger stores
the whole page in an account's `AppLoader` field. A node serves that page at
`/<account>`. The cap is 4096 bytes, so this directory builds a single HTML
document and checks it against the same rules consensus uses.

`tetris.html` is the document that goes on the ledger. It is a short wrapper
around a deflate-raw copy of the page, because the cap is 4096 bytes. The
browser inflates that copy and runs it. Edit `game.js` and `shell.html`, then
rebuild.

## Devnet

The PWA devnet (network id **21339**) has the `PWALoader` amendment enabled.

| | |
|--|--|
| WebSocket | `wss://pwapp.xahau-dev.net` |
| JSON-RPC | `https://rpc.pwapp.xahau-dev.net` |
| Explorer | `https://explorer.pwapp.xahau-dev.net` |
| Debug stream | `wss://pwapp.xahau-dev.net/debugstream/` |
| App loader | `https://pwa.pwapp.xahau-dev.net/<account>` |
| Faucet | `POST https://faucet.pwapp.xahau-dev.net/accounts` with body `{}` |

Transactions set `NetworkID` to `21339`.

## Build and publish

From this directory, after `npm install`:

```bash
npm run build
npm test
npm run publish
```

`publish.mjs` funds a new faucet account unless `XAHAU_SEED` is set, then sends
an `AccountSet` whose `AppLoader` is the hex of `tetris.html`. The fee is the
open-ledger base fee plus one drop per byte, multiplied by the current load
scale. The script waits until `https://pwa.pwapp.xahau-dev.net/<account>`
serves those exact bytes, and prints the account seed so the page can be replaced.

Play with the arrow keys and space to drop. On a phone, use the buttons or
swipe the board. Left, right, and down repeat while held.

## Doom

`doom.html` is a second boot document. It redirects to
[three-doom](https://mrdoob.github.io/three-doom/).

```bash
node build.mjs doom
node publish.mjs doom
```
