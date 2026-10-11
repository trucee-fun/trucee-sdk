/**
 * Program ids and on-chain constants mirrored from zpvp/programs (router math.rs and account layouts).
 */
import { PublicKey } from '@solana/web3.js'
import type { Cluster, ClusterConfig } from './types.js'

export const ROUTER_PROGRAM_ID = new PublicKey('D4sk6wwELD6cmd7tv6hE4hkxQP8SF8tjdegYym8iWNNb')
export const HOOK_PROGRAM_ID = new PublicKey('CUNNV1MqVB53N4jWn91uVFXm1dBSyaynR6iBCbufJWMS')
export const DBC_PROGRAM_ID = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN')

/** DBC fee numerators are parts per FEE_DENOMINATOR. */
export const FEE_DENOMINATOR = 1_000_000_000n
/** Basis withheld per buy to absorb DBC's pool-favoured rounding. */
export const DUST_PER_BUY = 16n
/** Withheld per exit so many tiny exits cannot drain the buffer through rounding dust. */
export const HAIRCUT_PER_EXIT = 2n

/** Market: discriminator 8 | 7 pubkeys | fee u64 | bump u8 | total_basis u64 | finalized u8 | 3 x u64. */
export const MARKET_ACCOUNT_SIZE = 274
/** Position without auto-exit: discriminator 8 | owner | market | tokens u64 | basis u64 | bump u8. */
export const POSITION_ACCOUNT_SIZE_V1 = 89
/** Position with the trailing auto_exit_deadline i64. */
export const POSITION_ACCOUNT_SIZE_V2 = 97

export function getClusterConfig(cluster: Cluster): ClusterConfig {
  throw new Error('not implemented: getClusterConfig')
}
