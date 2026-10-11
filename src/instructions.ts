/**
 * Instruction builders for the router (init_market, buy, sell, finalize, claim_surplus) and the hook
 * (initialize_extra_account_meta_list). Account orders follow zpvp/programs/{zpvp_router,zpvp_hook}/src/lib.rs.
 */
import type { PublicKey, TransactionInstruction } from '@solana/web3.js'
import { HOOK_PROGRAM_ID } from './constants.js'
import type { BuyParams, ClaimParams, FinalizeParams, InitMarketParams, SellParams } from './types.js'

/** Buy through the router; wraps SOL first when the quote mint is native. */
export function buyInstructions(p: BuyParams): TransactionInstruction[] {
  throw new Error('not implemented: buyInstructions')
}

/** Exit at cost through the router; appends the wSOL unwrap when `unwrapSol` is set. */
export function sellInstructions(p: SellParams): TransactionInstruction[] {
  throw new Error('not implemented: sellInstructions')
}

export function finalizeInstruction(p: FinalizeParams): TransactionInstruction {
  throw new Error('not implemented: finalizeInstruction')
}

export function claimSurplusInstruction(p: ClaimParams): TransactionInstruction {
  throw new Error('not implemented: claimSurplusInstruction')
}

export function initMarketInstruction(p: InitMarketParams): TransactionInstruction {
  throw new Error('not implemented: initMarketInstruction')
}

export function initExtraAccountMetasInstruction(
  payer: PublicKey,
  baseMint: PublicKey,
  hookProgramId: PublicKey = HOOK_PROGRAM_ID,
): TransactionInstruction {
  throw new Error('not implemented: initExtraAccountMetasInstruction')
}
