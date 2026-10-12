/**
 * Custom program errors of the router and the hook (Anchor #[error_code], numbered from 6000),
 * and a decoder that maps a failed transaction (router, hook, DBC, Anchor framework, wallet) to a DecodedTxError.
 */
import { DynamicBondingCurveIdl } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { DBC_PROGRAM_ID, HOOK_PROGRAM_ID, ROUTER_PROGRAM_ID } from './constants.js'
import type { DecodedTxError } from './types.js'

interface ErrorInfo {
  readonly name: string
  readonly message: string
}

type ErrorTable = Readonly<Record<number, ErrorInfo>>

interface KnownProgram {
  readonly label: DecodedTxError['program']
  readonly errors: ErrorTable
}

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
  6019: { name: 'AutoExitDeadlineInPast', message: 'Auto-exit deadline must be in the future (or 0 to clear)' },
  6020: { name: 'AutoExitNotDue', message: 'Auto-exit deadline not reached (or auto-exit not set)' },
  6021: { name: 'AutoExitCurveComplete', message: 'Curve is complete: auto-exit is no longer possible' },
  // RouterError variants keep their enum order and exact on-chain messages.
  6022: { name: 'PositionCapExceeded', message: 'Buy would exceed the anti-whale cap (20% of curve supply)' },
  6023: {
    name: 'PresetNotAllowed',
    message: 'Config breaks the Zero-PvP preset (creator allocation, fixed supply or unlocked LP)',
  },
  6024: { name: 'FeeTooHigh', message: 'Config fee is above the 1% cap' },
})

/** HookError in zpvp/programs/zpvp_hook/src/lib.rs. */
export const HOOK_ERRORS: Readonly<Record<number, { name: string; message: string }>> = Object.freeze({
  6000: { name: 'TransferNotViaRouter', message: 'Pre-graduation transfers must go through the Zero-PvP router' },
})

/** Builds a table whose codes run on from `first`, like an Anchor enum with one explicit discriminant. */
function sequentialTable(first: number, rows: readonly (readonly [string, string])[]): Record<number, ErrorInfo> {
  return Object.fromEntries(rows.map(([name, message], i) => [first + i, Object.freeze({ name, message })]))
}

/** Anchor framework errors 2000-3999 (anchor-lang 0.32 ErrorCode, as used by the router and the hook). */
const ANCHOR_ERRORS: ErrorTable = Object.freeze({
  ...sequentialTable(2000, [
    ['ConstraintMut', 'A mut constraint was violated'],
    ['ConstraintHasOne', 'A has one constraint was violated'],
    ['ConstraintSigner', 'A signer constraint was violated'],
    ['ConstraintRaw', 'A raw constraint was violated'],
    ['ConstraintOwner', 'An owner constraint was violated'],
    ['ConstraintRentExempt', 'A rent exemption constraint was violated'],
    ['ConstraintSeeds', 'A seeds constraint was violated'],
    ['ConstraintExecutable', 'An executable constraint was violated'],
    ['ConstraintState', 'Deprecated Error, feel free to replace with something else'],
    ['ConstraintAssociated', 'An associated constraint was violated'],
    ['ConstraintAssociatedInit', 'An associated init constraint was violated'],
    ['ConstraintClose', 'A close constraint was violated'],
    ['ConstraintAddress', 'An address constraint was violated'],
    ['ConstraintZero', 'Expected zero account discriminant'],
    ['ConstraintTokenMint', 'A token mint constraint was violated'],
    ['ConstraintTokenOwner', 'A token owner constraint was violated'],
    ['ConstraintMintMintAuthority', 'A mint mint authority constraint was violated'],
    ['ConstraintMintFreezeAuthority', 'A mint freeze authority constraint was violated'],
    ['ConstraintMintDecimals', 'A mint decimals constraint was violated'],
    ['ConstraintSpace', 'A space constraint was violated'],
    ['ConstraintAccountIsNone', 'A required account for the constraint is None'],
    ['ConstraintTokenTokenProgram', 'A token account token program constraint was violated'],
    ['ConstraintMintTokenProgram', 'A mint token program constraint was violated'],
    ['ConstraintAssociatedTokenTokenProgram', 'An associated token account token program constraint was violated'],
    ['ConstraintMintGroupPointerExtension', 'A group pointer extension constraint was violated'],
    ['ConstraintMintGroupPointerExtensionAuthority', 'A group pointer extension authority constraint was violated'],
    [
      'ConstraintMintGroupPointerExtensionGroupAddress',
      'A group pointer extension group address constraint was violated',
    ],
    ['ConstraintMintGroupMemberPointerExtension', 'A group member pointer extension constraint was violated'],
    [
      'ConstraintMintGroupMemberPointerExtensionAuthority',
      'A group member pointer extension authority constraint was violated',
    ],
    [
      'ConstraintMintGroupMemberPointerExtensionMemberAddress',
      'A group member pointer extension group address constraint was violated',
    ],
    ['ConstraintMintMetadataPointerExtension', 'A metadata pointer extension constraint was violated'],
    [
      'ConstraintMintMetadataPointerExtensionAuthority',
      'A metadata pointer extension authority constraint was violated',
    ],
    [
      'ConstraintMintMetadataPointerExtensionMetadataAddress',
      'A metadata pointer extension metadata address constraint was violated',
    ],
    ['ConstraintMintCloseAuthorityExtension', 'A close authority constraint was violated'],
    ['ConstraintMintCloseAuthorityExtensionAuthority', 'A close authority extension authority constraint was violated'],
    ['ConstraintMintPermanentDelegateExtension', 'A permanent delegate extension constraint was violated'],
    [
      'ConstraintMintPermanentDelegateExtensionDelegate',
      'A permanent delegate extension delegate constraint was violated',
    ],
    ['ConstraintMintTransferHookExtension', 'A transfer hook extension constraint was violated'],
    ['ConstraintMintTransferHookExtensionAuthority', 'A transfer hook extension authority constraint was violated'],
    [
      'ConstraintMintTransferHookExtensionProgramId',
      'A transfer hook extension transfer hook program id constraint was violated',
    ],
  ]),
  ...sequentialTable(2500, [
    ['RequireViolated', 'A require expression was violated'],
    ['RequireEqViolated', 'A require_eq expression was violated'],
    ['RequireKeysEqViolated', 'A require_keys_eq expression was violated'],
    ['RequireNeqViolated', 'A require_neq expression was violated'],
    ['RequireKeysNeqViolated', 'A require_keys_neq expression was violated'],
    ['RequireGtViolated', 'A require_gt expression was violated'],
    ['RequireGteViolated', 'A require_gte expression was violated'],
  ]),
  ...sequentialTable(3000, [
    ['AccountDiscriminatorAlreadySet', 'The account discriminator was already set on this account'],
    ['AccountDiscriminatorNotFound', 'No discriminator was found on the account'],
    ['AccountDiscriminatorMismatch', 'Account discriminator did not match what was expected'],
    ['AccountDidNotDeserialize', 'Failed to deserialize the account'],
    ['AccountDidNotSerialize', 'Failed to serialize the account'],
    ['AccountNotEnoughKeys', 'Not enough account keys given to the instruction'],
    ['AccountNotMutable', 'The given account is not mutable'],
    ['AccountOwnedByWrongProgram', 'The given account is owned by a different program than expected'],
    ['InvalidProgramId', 'Program ID was not as expected'],
    ['InvalidProgramExecutable', 'Program account is not executable'],
    ['AccountNotSigner', 'The given account did not sign'],
    ['AccountNotSystemOwned', 'The given account is not owned by the system program'],
    ['AccountNotInitialized', 'The program expected this account to be already initialized'],
    ['AccountNotProgramData', 'The given account is not a program data account'],
    ['AccountNotAssociatedTokenAccount', 'The given account is not the associated token account'],
    ['AccountSysvarMismatch', 'The given public key does not match the required sysvar'],
    ['AccountReallocExceedsLimit', 'The account reallocation exceeds the MAX_PERMITTED_DATA_INCREASE limit'],
    ['AccountDuplicateReallocs', 'The account was duplicated for more than one reallocation'],
  ]),
})

/** Meteora DBC errors, from the IDL the DBC SDK ships for program dbcij3… (empty if the SDK ever points elsewhere). */
const DBC_ERRORS: ErrorTable = Object.freeze(
  DynamicBondingCurveIdl.address === DBC_PROGRAM_ID.toBase58()
    ? Object.fromEntries(
        DynamicBondingCurveIdl.errors.map((e) => [e.code, Object.freeze({ name: e.name, message: e.msg })]),
      )
    : {},
)

const KNOWN_PROGRAMS: ReadonlyMap<string, KnownProgram> = new Map([
  [ROUTER_PROGRAM_ID.toBase58(), { label: 'router', errors: ROUTER_ERRORS }],
  [HOOK_PROGRAM_ID.toBase58(), { label: 'hook', errors: HOOK_ERRORS }],
  [DBC_PROGRAM_ID.toBase58(), { label: 'dbc', errors: DBC_ERRORS }],
])

/** Solana logs the innermost failing program first; outer callers re-emit the same code after it. */
const PROGRAM_FAILED = /Program ([1-9A-HJ-NP-Za-km-z]{32,44}) failed: custom program error: 0x([0-9a-fA-F]{1,8})\b/
const CUSTOM_HEX = /custom program error: 0x([0-9a-fA-F]{1,8})\b/
/** LiteSVM's `TransactionErrorInstructionError { index, error: InstructionErrorCustom { code } }`. */
const LITESVM_CUSTOM = /InstructionErrorCustom \{ code: (\d{1,10}) \}/
const WALLET_REJECTION = /reject/i
/** Wallet-adapter WalletError keeps its cause in `error`; standard errors use `cause`. */
const INNER_ERROR_KEYS = ['error', 'cause'] as const

const MAX_U32 = 0xffff_ffff
const FIRST_PROGRAM_ERROR_CODE = 6000
const CUSTOM_PROGRAM_ERROR = 'CustomProgramError'
const WALLET_REJECTED = 'UserRejected'
const WALLET_REJECTED_MESSAGE = 'The transaction was rejected in the wallet'

/**
 * Maps a send/simulate error (or its logs) to a known program error; null when nothing is recognised.
 * Accepts web3.js SendTransactionError (its `logs`, else the code in its message), `{ logs }` simulation results,
 * `{ InstructionError: [index, { Custom: code }] }`, LiteSVM error strings and wallet-adapter errors (also their
 * wrapped cause). The program is taken from the first (innermost) `Program <id> failed: custom program error` line.
 */
export function decodeTxError(err: unknown): DecodedTxError | null {
  const sources = errorSources(err)
  const texts = [...sources.flatMap(logText), ...sources.flatMap(messageText)]
  return decodeFailedProgramLine(texts) ?? decodeBareCode(sources, texts) ?? decodeWalletRejection(sources)
}

function decodeFailedProgramLine(texts: readonly string[]): DecodedTxError | null {
  for (const text of texts) {
    const match = PROGRAM_FAILED.exec(text)
    const code = parseCode(match?.[2], 16)
    if (match && code !== null) return decodeCode(KNOWN_PROGRAMS.get(match[1] ?? ''), code)
  }
  return null
}

function decodeBareCode(sources: readonly unknown[], texts: readonly string[]): DecodedTxError | null {
  const code =
    sources.map(instructionErrorCode).find(isCode) ??
    texts.map((text) => parseCode(LITESVM_CUSTOM.exec(text)?.[1], 10)).find(isCode) ??
    texts.map((text) => parseCode(CUSTOM_HEX.exec(text)?.[1], 16)).find(isCode)
  return code === undefined ? null : decodeCode(undefined, code)
}

function decodeWalletRejection(sources: readonly unknown[]): DecodedTxError | null {
  const rejection = sources.find((source) =>
    [readProperty(source, 'name'), readProperty(source, 'message')].some(
      (value) => typeof value === 'string' && WALLET_REJECTION.test(value),
    ),
  )
  if (rejection === undefined) return null
  const message = readProperty(rejection, 'message')
  const readable = typeof message === 'string' && message.trim() !== '' ? message : WALLET_REJECTED_MESSAGE
  return decoded('wallet', null, WALLET_REJECTED, readable)
}

/** Program table first, then Anchor's framework codes; other codes only count from a known program or >= 6000. */
function decodeCode(program: KnownProgram | undefined, code: number): DecodedTxError | null {
  const label = program?.label ?? 'unknown'
  const known = (program && lookup(program.errors, code)) ?? lookup(ANCHOR_ERRORS, code)
  if (known) return decoded(label, code, known.name, known.message)
  if (program === undefined && code < FIRST_PROGRAM_ERROR_CODE) return null
  return decoded(label, code, CUSTOM_PROGRAM_ERROR, `Custom program error ${code} (0x${code.toString(16)})`)
}

function decoded(
  program: DecodedTxError['program'],
  code: number | null,
  name: string,
  message: string,
): DecodedTxError {
  return Object.freeze({ program, code, name, message })
}

function lookup(table: ErrorTable, code: number): ErrorInfo | undefined {
  return Object.hasOwn(table, code) ? table[code] : undefined
}

/** The error itself plus its wrapped cause (one level), ignoring empty values. */
function errorSources(err: unknown): readonly unknown[] {
  const inner = INNER_ERROR_KEYS.map((key) => readProperty(err, key))
  return [err, ...inner].filter((value, i, all) => value !== undefined && value !== null && all.indexOf(value) === i)
}

function logText(source: unknown): string[] {
  const logs = readProperty(source, 'logs')
  const isLogList = Array.isArray(logs) && logs.length > 0 && logs.every((line) => typeof line === 'string')
  return isLogList ? [logs.join('\n')] : []
}

function messageText(source: unknown): string[] {
  if (typeof source === 'string') return [source]
  const message = readProperty(source, 'message')
  return typeof message === 'string' ? [message] : []
}

/** `{ InstructionError: [index, { Custom: code }] }` as returned by the RPC for a failed transaction. */
function instructionErrorCode(source: unknown): number | null {
  const instructionError = readProperty(source, 'InstructionError')
  if (!Array.isArray(instructionError) || instructionError.length !== 2) return null
  const [index, detail]: unknown[] = instructionError
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) return null
  return validCode(readProperty(detail, 'Custom'))
}

function parseCode(digits: string | undefined, radix: 10 | 16): number | null {
  return digits === undefined ? null : validCode(Number.parseInt(digits, radix))
}

function validCode(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_U32 ? value : null
}

function isCode(value: number | null): value is number {
  return value !== null
}

/** Reads a property of an untrusted value; a throwing getter counts as an absent property. */
function readProperty(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined
  try {
    return (value as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}
