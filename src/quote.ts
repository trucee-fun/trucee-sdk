/**
 * Buy and exit quotes. Exit math mirrors zpvp/programs/zpvp_router/src/math.rs exactly.
 */
import type { Connection } from '@solana/web3.js'
import type { BuyQuote, ExitQuote, MarketAccount, PositionAccount } from './types.js'

/** basis_part - ceil(basis_part * fee / FEE_DENOMINATOR) - HAIRCUT_PER_EXIT, floored at zero. */
export function refundFor(basisPart: bigint, feeNumerator: bigint): bigint {
  throw new Error('not implemented: refundFor')
}

/** Pro-rata basis for selling `tokens`; null when tokens is 0 or above the position. */
export function basisForExit(positionTokens: bigint, positionBasis: bigint, tokens: bigint): bigint | null {
  throw new Error('not implemented: basisForExit')
}

/** Guaranteed pre-graduation exit value of the whole position ("Your floor"). */
export function floorValue(position: PositionAccount, market: MarketAccount): bigint {
  throw new Error('not implemented: floorValue')
}

export function quoteExit(position: PositionAccount, market: MarketAccount, tokens: bigint): ExitQuote {
  throw new Error('not implemented: quoteExit')
}

export async function quoteBuy(connection: Connection, market: MarketAccount, amountIn: bigint): Promise<BuyQuote> {
  throw new Error('not implemented: quoteBuy')
}
