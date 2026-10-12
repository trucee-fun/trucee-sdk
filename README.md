# Trucee SDK

`@trucee/sdk` is the TypeScript client for Trucee's Zero-PvP curve. It decodes router accounts and events, derives addresses, builds launch and trading instructions, calculates buy quotes and exits at cost before graduation, and decodes transaction errors. Amounts are `bigint` values in raw token units.

## Install

```sh
npm install @trucee/sdk @solana/web3.js @solana/spl-token @meteora-ag/dynamic-bonding-curve-sdk bn.js buffer
```

The Solana and Meteora packages are peer dependencies, so your app and the SDK share one copy of each.

## Clusters

The router and hook use the same program IDs on every cluster. `getClusterConfig('mainnet-beta')` quotes in SOL, TSLAx and NVDAx; `getClusterConfig('devnet')` in SOL only; `getClusterConfig('localnet')` matches mainnet for LiteSVM tests.

## Example

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

## Development

```sh
git clone https://github.com/trucee-fun/trucee-sdk sdk
cd sdk
npm install
npm run build
```

Run checks from `sdk/`:

```sh
npm run build
npm run typecheck
npm test -- --maxWorkers=2
```

Offline tests run in a standalone clone. LiteSVM suites run when all four workspace files from the sibling repositories (`trucee-programs` checked out as `../zpvp`, `trucee-litesvm-diff` as `../litesvm-diff`) exist: `../litesvm-diff/programs/dbc.so`, `../litesvm-diff/out/scenario_tiny.json`, `../zpvp/target/deploy/zpvp_hook.so` and `../zpvp/target/deploy/zpvp_router.so`. When any is missing, those suites skip and include the missing paths in their titles. Sibling files are only needed for these integration suites.

See the [Quickstart](https://docs.trucee.fun/quickstart), the [Programs reference](https://docs.trucee.fun/programs-reference) for every instruction, account and error code, and the [project overview](https://github.com/trucee-fun/trucee). Licensed under [MIT](https://github.com/trucee-fun/trucee-sdk/blob/main/LICENSE).
