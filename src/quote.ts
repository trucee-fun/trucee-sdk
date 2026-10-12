/**
 * Buy and exit quotes before graduation and the floor value until graduation, including the 2-lamport haircut.
 * Exit math mirrors zpvp/programs/zpvp_router/src/math.rs exactly;
 * the buy quote runs the DBC SDK's curve math over the live pool and config, the way the router's buy swaps.
 */
import { Buffer } from 'buffer'
import BN from 'bn.js'
import type { AccountInfo, Connection, PublicKey } from '@solana/web3.js'
import {
  createDbcProgram,
  swapQuotePartialFill,
  type ConfigWithTransferHook,
  type TransferHookPool,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import { DUST_PER_BUY, FEE_DENOMINATOR, HAIRCUT_PER_EXIT } from './constants.js'
import type { BuyQuote, ExitQuote, MarketAccount, PositionAccount } from './types.js'

const U64_MAX = (1n << 64n) - 1n
/** DBC CollectFeeMode::QuoteToken: a buy pays the fee on its quote input (the only mode the router accepts). */
const COLLECT_FEE_MODE_QUOTE_TOKEN = 0
/** Buy direction for the DBC SDK: quote in, base out. */
const SWAP_BASE_FOR_QUOTE = false
const NO_SLIPPAGE_BPS = 0
/** The router's DBC swap passes no referral account. */
const HAS_REFERRAL = false
/** Router buys never take DBC's bundled-first-swap minimum fee. */
const FIRST_SWAP_WITH_MIN_FEE = false

type DbcProgram = ReturnType<typeof createDbcProgram>['program']
type DbcAccountName = 'transferHookPool' | 'configWithTransferHook'

function assertU64(value: bigint, name: string, fn: string): void {
  if (typeof value !== 'bigint') throw new TypeError(`${fn}: ${name} must be a bigint, got ${typeof value}`)
  if (value < 0n || value > U64_MAX) throw new RangeError(`${fn}: ${name} must fit in a u64, got ${value}`)
}

const saturatingSub = (a: bigint, b: bigint): bigint => (a > b ? a - b : 0n)

/** math.rs: ceil(basis_part * fee / FEE_DENOMINATOR) in u128, saturated to u64. Inputs are validated u64s. */
function feeAtCostFor(basisPart: bigint, feeNumerator: bigint): bigint {
  const fee = (basisPart * feeNumerator + FEE_DENOMINATOR - 1n) / FEE_DENOMINATOR
  return fee > U64_MAX ? U64_MAX : fee
}

/** math.rs basis_for_buy: net quote that entered the curve minus the dust reserve, floored at zero. */
const basisForBuy = (netIntoCurve: bigint): bigint => saturatingSub(netIntoCurve, DUST_PER_BUY)

function assertSameMarket(position: PositionAccount, market: MarketAccount, fn: string): void {
  if (!position.market.equals(market.address)) {
    throw new Error(
      `${fn}: position ${position.address.toBase58()} belongs to market ${position.market.toBase58()}, not ${market.address.toBase58()}`,
    )
  }
}

/** basis_part - ceil(basis_part * fee / FEE_DENOMINATOR) - HAIRCUT_PER_EXIT, floored at zero. */
export function refundFor(basisPart: bigint, feeNumerator: bigint): bigint {
  assertU64(basisPart, 'basisPart', 'refundFor')
  assertU64(feeNumerator, 'feeNumerator', 'refundFor')
  return saturatingSub(saturatingSub(basisPart, feeAtCostFor(basisPart, feeNumerator)), HAIRCUT_PER_EXIT)
}

/** Pro-rata basis for selling `tokens`; null when tokens is 0 or above the position. */
export function basisForExit(positionTokens: bigint, positionBasis: bigint, tokens: bigint): bigint | null {
  assertU64(positionTokens, 'positionTokens', 'basisForExit')
  assertU64(positionBasis, 'positionBasis', 'basisForExit')
  assertU64(tokens, 'tokens', 'basisForExit')
  if (tokens === 0n || tokens > positionTokens) return null
  if (tokens === positionTokens) return positionBasis
  return (positionBasis * tokens) / positionTokens
}

/** Floor until graduation: the router pays max(0, basis - fee at cost - 2 lamports) on an exit before graduation. */
export function floorValue(position: PositionAccount, market: MarketAccount): bigint {
  assertSameMarket(position, market, 'floorValue')
  return refundFor(position.basis, market.feeNumerator)
}

/**
 * Exit at cost before graduation of `tokens` out of `position`: the basis released, the fee charged as if selling
 * at cost, and the refund the router pays (basis part - fee at cost - 2 lamports, floored at zero).
 *
 * @throws RangeError when `tokens` is 0 or above the position (the router's InvalidExitAmount).
 */
export function quoteExit(position: PositionAccount, market: MarketAccount, tokens: bigint): ExitQuote {
  assertSameMarket(position, market, 'quoteExit')
  const basisPart = basisForExit(position.tokens, position.basis, tokens)
  if (basisPart === null) {
    throw new RangeError(`quoteExit: tokens must be > 0 and <= the position's ${position.tokens}, got ${tokens}`)
  }
  const refund = refundFor(basisPart, market.feeNumerator)
  return Object.freeze({ basisPart, feeAtCost: feeAtCostFor(basisPart, market.feeNumerator), refund })
}

function decodeDbcAccount<T>(program: DbcProgram, name: DbcAccountName, address: PublicKey, info: AccountInfo<Buffer> | null): T {
  const label = `quoteBuy: DBC ${name} ${address.toBase58()}`
  if (info === null) throw new Error(`${label} does not exist`)
  if (!info.owner.equals(program.programId)) {
    throw new Error(`${label} is owned by ${info.owner.toBase58()}, not the DBC program ${program.programId.toBase58()}`)
  }
  try {
    return program.coder.accounts.decode<T>(name, Buffer.from(info.data))
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`${label} could not be decoded: ${reason}`, { cause: error })
  }
}

async function fetchCurve(connection: Connection, market: MarketAccount) {
  const { program } = createDbcProgram(connection)
  const [poolInfo, configInfo] = await connection.getMultipleAccountsInfo([market.pool, market.config])
  const pool = decodeDbcAccount<TransferHookPool>(program, 'transferHookPool', market.pool, poolInfo ?? null)
  const { config } = decodeDbcAccount<ConfigWithTransferHook>(program, 'configWithTransferHook', market.config, configInfo ?? null)
  if (!pool.poolState.config.equals(market.config)) {
    throw new Error(`quoteBuy: pool ${market.pool.toBase58()} uses config ${pool.poolState.config.toBase58()}, not the market's ${market.config.toBase58()}`)
  }
  if (config.collectFeeMode !== COLLECT_FEE_MODE_QUOTE_TOKEN) {
    throw new Error(`quoteBuy: config ${market.config.toBase58()} collects fees in mode ${config.collectFeeMode}, expected the quote token`)
  }
  if (pool.poolState.quoteReserve.gte(config.migrationQuoteThreshold)) {
    throw new Error(`quoteBuy: the curve of pool ${market.pool.toBase58()} is complete; buys are closed`)
  }
  return { pool, config }
}

const toBigint = (value: BN): bigint => BigInt(value.toString())

/**
 * Quote of a router buy of `amountIn` quote units against the pool's current state.
 *
 * Mirrors the router: DBC swaps in partial-fill mode with the fee charged on the input, so on the buy that
 * completes the curve only the input up to the migration price is taken; `fee` and `netIntoCurve` cover that
 * consumed input (netIntoCurve = amountIn - fee whenever the buy fills completely). netIntoCurve is the pool's
 * quote-reserve increase, i.e. the BuyEvent's net_into_curve. The fee is static (the router rejects time- or
 * volume-dependent fees), so the current slot does not change the quote. The Anti-Whale cap is not checked here.
 *
 * @throws TypeError / RangeError when `amountIn` is not a positive u64 bigint; Error when the DBC accounts are
 *   missing or invalid, or the curve is already complete.
 */
export async function quoteBuy(connection: Connection, market: MarketAccount, amountIn: bigint): Promise<BuyQuote> {
  assertU64(amountIn, 'amountIn', 'quoteBuy')
  if (amountIn === 0n) throw new RangeError('quoteBuy: amountIn must be > 0')
  const { pool, config } = await fetchCurve(connection, market)
  const result = swapQuotePartialFill(
    pool, config, SWAP_BASE_FOR_QUOTE, new BN(amountIn.toString()), NO_SLIPPAGE_BPS, HAS_REFERRAL,
    pool.poolState.activationPoint, FIRST_SWAP_WITH_MIN_FEE,
  )
  const consumed = toBigint(result.includedFeeInputAmount)
  const netIntoCurve = toBigint(result.excludedFeeInputAmount)
  return Object.freeze({
    tokensOut: toBigint(result.outputAmount),
    fee: consumed - netIntoCurve,
    netIntoCurve,
    basisAdded: basisForBuy(netIntoCurve),
  })
}
