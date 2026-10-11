/**
 * Program-derived addresses of the router (market, buffer, position) and the hook (extra-account-metas).
 */
import type { PublicKey } from '@solana/web3.js'
import { HOOK_PROGRAM_ID, ROUTER_PROGRAM_ID } from './constants.js'

/** ["market", pool] under the router. */
export function findMarketPda(pool: PublicKey, routerProgramId: PublicKey = ROUTER_PROGRAM_ID): PublicKey {
  throw new Error('not implemented: findMarketPda')
}

/** ["buffer", market] under the router: the market's quote buffer vault. */
export function findBufferPda(market: PublicKey, routerProgramId: PublicKey = ROUTER_PROGRAM_ID): PublicKey {
  throw new Error('not implemented: findBufferPda')
}

/** ["position", market, owner] under the router. */
export function findPositionPda(
  market: PublicKey,
  owner: PublicKey,
  routerProgramId: PublicKey = ROUTER_PROGRAM_ID,
): PublicKey {
  throw new Error('not implemented: findPositionPda')
}

/** ["extra-account-metas", baseMint] under the hook. */
export function findExtraAccountMetasPda(baseMint: PublicKey, hookProgramId: PublicKey = HOOK_PROGRAM_ID): PublicKey {
  throw new Error('not implemented: findExtraAccountMetasPda')
}
