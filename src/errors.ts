/**
 * Custom program errors of the router and the hook (Anchor #[error_code], numbered from 6000),
 * and a decoder that maps a failed transaction to one of them.
 */
import type { DecodedTxError } from './types.js'

/** RouterError in zpvp/programs/zpvp_router/src/lib.rs, in enum order. */
export const ROUTER_ERRORS: Readonly<Record<number, { name: string; message: string }>> = Object.freeze({
  6000: { name: 'NotDbcAccount', message: 'Account is not owned by the DBC program' },
  6001: { name: 'NotTransferHookPool', message: 'Pool is not a DBC transfer-hook pool' },
  6002: { name: 'NotTransferHookConfig', message: 'Config is not a DBC transfer-hook config' },
  6003: {
    name: 'BadHookAccounts',
    message: 'Expected [extra-account-metas, instructions sysvar, hook program] as remaining accounts',
  },
  6004: { name: 'PoolConfigMismatch', message: 'Pool does not belong to this config' },
  6005: { name: 'MintMismatch', message: 'Mint does not match the pool' },
  6006: { name: 'ZeroOutput', message: 'Swap produced no tokens' },
  6007: { name: 'InvalidExitAmount', message: 'Exit amount must be > 0 and <= position' },
  6008: { name: 'MathOverflow', message: 'Arithmetic overflow' },
  6009: { name: 'CurveNotComplete', message: 'Curve is not complete yet' },
  6010: { name: 'AlreadyFinalized', message: 'Market already finalized' },
  6011: { name: 'NotFinalized', message: 'Market not finalized yet' },
  6012: { name: 'NotPositionOwner', message: 'Account is not the position owner' },
  6013: { name: 'WrongTransferHook', message: "Config's transfer hook is not zpvp_hook" },
  6014: {
    name: 'UnsupportedFeeConfig',
    message: 'Only static quote-collected fees are supported (no scheduler, rate limiter or dynamic fee)',
  },
  6015: { name: 'BufferInsufficient', message: 'Buffer cannot cover the refund' },
  6016: { name: 'SurplusOverclaimed', message: 'Claims would exceed the surplus snapshot' },
  6017: { name: 'QuoteMintNotAllowed', message: 'Mainnet beta: quote mint is not on the allowlist' },
  6018: { name: 'ThresholdTooHigh', message: 'Mainnet beta: migration quote threshold above the cap' },
})

/** HookError in zpvp/programs/zpvp_hook/src/lib.rs. */
export const HOOK_ERRORS: Readonly<Record<number, { name: string; message: string }>> = Object.freeze({
  6000: { name: 'TransferNotViaRouter', message: 'Pre-graduation transfers must go through the Zero-PvP router' },
})

/** Maps a send/simulate error (or its logs) to a known program error; null when nothing is recognised. */
export function decodeTxError(err: unknown): DecodedTxError | null {
  throw new Error('not implemented: decodeTxError')
}
