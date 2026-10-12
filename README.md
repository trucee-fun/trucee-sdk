# Trucee SDK

`@trucee/sdk` is the TypeScript client for Trucee's Zero-PvP curve. It decodes router accounts and events, derives addresses, builds launch and trading instructions, calculates buy quotes and exits at cost before graduation, and decodes transaction errors. Amounts are `bigint` values in raw token units.

Clone the repositories side by side using these workspace folder names so sibling paths keep working:

```sh
mkdir trucee && cd trucee
git clone https://github.com/trucee-fun/trucee-programs zpvp
git clone https://github.com/trucee-fun/trucee-sdk sdk
git clone https://github.com/trucee-fun/trucee-app app
git clone https://github.com/trucee-fun/trucee-sim sim
git clone https://github.com/trucee-fun/trucee-worker worker
git clone https://github.com/trucee-fun/trucee-litesvm-diff litesvm-diff
git clone https://github.com/trucee-fun/trucee-docs gitbook
cd sdk
npm install
npm run build
```

The SDK can also be cloned alone; its build and offline tests need no sibling repositories. In a sibling project, install it with `npm install ../sdk` or declare `"@trucee/sdk": "file:../sdk"`. This package is consumed locally through the workspace rather than installed from a registry.

For a SOL market on devnet before graduation, supply a web3.js `connection`, a decoded `market` from `fetchMarket`, and the wallet's `user` public key. Here `send(instructions)` is your wallet helper that builds, signs, sends and confirms a transaction before resolving. This example quotes a buy with 1% slippage tolerance, then quotes and submits an exit at cost before graduation, including the 2-lamport haircut:

```ts
import { buyInstructions, fetchPositionsByOwner, getClusterConfig, marketAccountsFor, quoteBuy, quoteExit, sellInstructions } from '@trucee/sdk'
const cluster = getClusterConfig('devnet')
const accounts = marketAccountsFor(market, cluster.quoteMints[0]!.tokenProgram)
const buy = await quoteBuy(connection, market, 1_000_000n)
const buyIxs = buyInstructions({ cluster, accounts, user, amountIn: 1_000_000n, minOut: buy.tokensOut * 99n / 100n })
await send(buyIxs)
const position = (await fetchPositionsByOwner(connection, user)).find((p) => p.market.equals(market.address))
if (!position) throw new Error('Position missing')
console.log(quoteExit(position, market, position.tokens))
await send(sellInstructions({ cluster, accounts, user, tokens: position.tokens, unwrapSol: true }))
```

Launches use a static fee from DBC's `MIN_FEE_BPS` (25 bps) through `ROUTER_MAX_FEE_BPS` (100 bps, or 1%). The SDK rejects values outside that range. The router rejects a config above the 1% cap with `FeeTooHigh` (6024).

For a SOL market, the floor until graduation is `max(0, basis - fee at cost - 2 lamports)`. The fee at cost is `ceil(basis × feeNumerator / 1_000_000_000)`; a 1% fee has numerator `10_000_000`. Basis is the tracked net quote amount after buy fees and the 16-unit reserve per buy, so it differs from the gross amount spent. For a partial exit before graduation, the same calculation uses the pro-rata basis released and the 2-lamport haircut; for other quote tokens the haircut is 2 raw quote units. `quoteBuy` uses the pool's current state and does not check the router's 20% position cap.

Run checks from `sdk/`:

```sh
npm run build
npm run typecheck
npm test -- --maxWorkers=2
```

Offline tests run in a standalone clone. LiteSVM suites run when all four workspace files exist: `../litesvm-diff/programs/dbc.so`, `../litesvm-diff/out/scenario_tiny.json`, `../zpvp/target/deploy/zpvp_hook.so` and `../zpvp/target/deploy/zpvp_router.so`. When any is missing, those suites skip and include the missing paths in their titles. Sibling files are only needed for these integration suites.

See the [router program](https://github.com/trucee-fun/trucee-programs/blob/main/programs/zpvp_router/src/lib.rs), [router math](https://github.com/trucee-fun/trucee-programs/blob/main/programs/zpvp_router/src/math.rs), and [Trucee documentation](https://github.com/trucee-fun/trucee-docs/blob/main/README.md). Licensed under [MIT](https://github.com/trucee-fun/trucee-sdk/blob/main/LICENSE).
