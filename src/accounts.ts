/**
 * Decoders and fetchers for router Market and Position accounts.
 */
import { Buffer } from 'buffer'
import type { Connection, PublicKey } from '@solana/web3.js'
import { ROUTER_PROGRAM_ID } from './constants.js'
import type { MarketAccount, MarketAccounts, PositionAccount } from './types.js'

export function decodeMarket(address: PublicKey, data: Buffer): MarketAccount {
  throw new Error('not implemented: decodeMarket')
}

/** Accepts both the 89-byte (no auto-exit) and the 97-byte layout. */
export function decodePosition(address: PublicKey, data: Buffer): PositionAccount {
  throw new Error('not implemented: decodePosition')
}

/** Resolves null when the account does not exist. */
export async function fetchMarket(connection: Connection, market: PublicKey): Promise<MarketAccount | null> {
  throw new Error('not implemented: fetchMarket')
}

export async function fetchAllMarkets(
  connection: Connection,
  routerProgramId: PublicKey = ROUTER_PROGRAM_ID,
): Promise<MarketAccount[]> {
  throw new Error('not implemented: fetchAllMarkets')
}

export async function fetchPositionsByOwner(
  connection: Connection,
  owner: PublicKey,
  routerProgramId: PublicKey = ROUTER_PROGRAM_ID,
): Promise<PositionAccount[]> {
  throw new Error('not implemented: fetchPositionsByOwner')
}

export function marketAccountsFor(market: MarketAccount, quoteTokenProgram: PublicKey): MarketAccounts {
  throw new Error('not implemented: marketAccountsFor')
}
