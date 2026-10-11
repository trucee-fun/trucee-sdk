/**
 * Instruction builders for the router (init_market, buy, sell, finalize, claim_surplus, set_auto_exit, auto_exit)
 * and the hook (initialize_extra_account_meta_list). Account orders follow zpvp/programs/{zpvp_router,zpvp_hook}/src/lib.rs.
 */
import { Buffer } from 'buffer'
import {
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  TransactionInstruction,
  type AccountMeta,
  type PublicKey,
} from '@solana/web3.js'
import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createApproveCheckedInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createRevokeInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import { deriveDbcEventAuthority, deriveDbcPoolAuthority } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { HOOK_PROGRAM_ID } from './constants.js'
import { findBufferPda, findExtraAccountMetasPda, findMarketPda, findPositionPda } from './pda.js'
import type {
  AutoExitParams,
  BuyParams,
  ClaimParams,
  ClusterConfig,
  FinalizeParams,
  InitMarketParams,
  MarketAccounts,
  SellParams,
  SetAutoExitParams,
} from './types.js'

/** sha256("global:<instruction>")[..8], the Anchor instruction discriminators. */
const DISCRIMINATORS = Object.freeze({
  buy: Object.freeze([102, 6, 61, 18, 1, 218, 235, 234]),
  sell: Object.freeze([51, 230, 133, 164, 1, 127, 131, 173]),
  finalize: Object.freeze([171, 61, 218, 56, 127, 115, 12, 217]),
  claimSurplus: Object.freeze([195, 35, 205, 205, 177, 146, 141, 62]),
  initMarket: Object.freeze([33, 253, 15, 116, 89, 25, 127, 236]),
  setAutoExit: Object.freeze([60, 166, 18, 156, 35, 166, 156, 226]),
  autoExit: Object.freeze([69, 201, 207, 131, 57, 141, 243, 167]),
  initializeExtraAccountMetaList: Object.freeze([92, 197, 174, 197, 41, 124, 19, 3]),
})

const DISCRIMINATOR_SIZE = 8
const U64_SIZE = 8
const U64_MAX = 2n ** 64n - 1n
const I64_MAX = 2n ** 63n - 1n
const PUBLIC_KEY_LENGTH = 32
/** `set_auto_exit` deadline that disables Auto-Exit. */
const AUTO_EXIT_DISABLED = 0n
/** Decimals of every Trucee base mint (DBC config tokenDecimal); approveChecked fails on any other mint. */
const BASE_TOKEN_DECIMALS = 6

const MARKET_ACCOUNT_FIELDS = Object.freeze([
  'market', 'pool', 'config', 'baseMint', 'quoteMint', 'baseVault', 'quoteVault', 'bufferVault', 'quoteTokenProgram',
] as const)
const CLUSTER_PROGRAM_FIELDS = Object.freeze(['routerProgramId', 'hookProgramId', 'dbcProgramId'] as const)
/** The only token programs a quote mint can live under. */
const QUOTE_TOKEN_PROGRAMS: readonly string[] = Object.freeze([TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()])

/* ---------- input validation ---------- */

/** Duck-typed so keys from another @solana/web3.js copy (common in apps) are still accepted. */
function requireKey(value: unknown, name: string): PublicKey {
  const key = value as { toBytes?: unknown; toBase58?: unknown } | null | undefined
  if (typeof key?.toBytes !== 'function' || typeof key.toBase58 !== 'function') {
    throw new TypeError(`${name} must be a PublicKey`)
  }
  const length = (key as PublicKey).toBytes().length
  if (length !== PUBLIC_KEY_LENGTH) throw new TypeError(`${name} must be a PublicKey of ${PUBLIC_KEY_LENGTH} bytes, got ${length}`)
  return key as PublicKey
}

function requireObject(value: unknown, name: string): void {
  if (typeof value !== 'object' || value === null) throw new TypeError(`${name} must be an object`)
}

function requireU64(value: unknown, name: string, min: bigint): bigint {
  if (typeof value !== 'bigint') throw new TypeError(`${name} must be a bigint in raw base units, got ${typeof value}`)
  if (value < min || value > U64_MAX) throw new RangeError(`${name} must be between ${min} and ${U64_MAX}, got ${value}`)
  return value
}

/** Auto-Exit deadline: unix seconds as a non-negative i64 bigint; 0n disables. */
function requireDeadline(value: unknown): bigint {
  if (typeof value !== 'bigint') throw new TypeError(`deadline must be a bigint of unix seconds (0n disables), got ${typeof value}`)
  if (value < AUTO_EXIT_DISABLED || value > I64_MAX) {
    throw new RangeError(`deadline must be between ${AUTO_EXIT_DISABLED} and ${I64_MAX} unix seconds, got ${value}`)
  }
  return value
}

function requireCluster(cluster: unknown): ClusterConfig {
  requireObject(cluster, 'cluster')
  CLUSTER_PROGRAM_FIELDS.forEach((field) => requireKey((cluster as ClusterConfig)[field], `cluster.${field}`))
  return cluster as ClusterConfig
}

function requireMarketAccounts(accounts: unknown): MarketAccounts {
  requireObject(accounts, 'accounts')
  MARKET_ACCOUNT_FIELDS.forEach((field) => requireKey((accounts as MarketAccounts)[field], `accounts.${field}`))
  return accounts as MarketAccounts
}

/** The router market PDA of `accounts.pool`; throws unless `accounts.market` is exactly that PDA. */
function requireMarketPda(cluster: ClusterConfig, accounts: MarketAccounts): PublicKey {
  const market = findMarketPda(accounts.pool, cluster.routerProgramId)
  if (market.toBase58() !== accounts.market.toBase58()) {
    throw new Error(`accounts.market ${accounts.market.toBase58()} is not the router market PDA of accounts.pool (${market.toBase58()})`)
  }
  return market
}

/* ---------- encoding and account metas ---------- */

function encodeData(discriminator: readonly number[], args: readonly bigint[] = []): Buffer {
  const bytes = new Uint8Array(DISCRIMINATOR_SIZE + U64_SIZE * args.length)
  bytes.set(discriminator)
  const view = new DataView(bytes.buffer)
  args.forEach((arg, i) => view.setBigUint64(DISCRIMINATOR_SIZE + U64_SIZE * i, arg, true))
  return Buffer.from(bytes)
}

const readonlyMeta = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false })
const writableMeta = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true })
const signerMeta = (pubkey: PublicKey, isWritable: boolean): AccountMeta => ({ pubkey, isSigner: true, isWritable })

/** wSOL: NATIVE_MINT under SPL Token. NATIVE_MINT under Token-2022 is not SOL, so it is never wrapped or unwrapped. */
const isNativeQuote = (accounts: MarketAccounts): boolean =>
  accounts.quoteMint.toBase58() === NATIVE_MINT.toBase58() && accounts.quoteTokenProgram.toBase58() === TOKEN_PROGRAM_ID.toBase58()
const quoteAtaOf = (accounts: MarketAccounts, owner: PublicKey): PublicKey =>
  getAssociatedTokenAddressSync(accounts.quoteMint, owner, false, accounts.quoteTokenProgram)
/**
 * allowOwnerOffCurve: a referrer may be a PDA wallet. The router only checks that the referral account is writable,
 * owned by the quote token program, of the quote mint and not a vault, so any owner works.
 */
const referrerQuoteAtaOf = (accounts: MarketAccounts, referrer: PublicKey): PublicKey =>
  getAssociatedTokenAddressSync(accounts.quoteMint, referrer, true, accounts.quoteTokenProgram)
const baseAtaOf = (accounts: MarketAccounts, owner: PublicKey): PublicKey =>
  getAssociatedTokenAddressSync(accounts.baseMint, owner, false, TOKEN_2022_PROGRAM_ID)

interface SwapContext {
  readonly cluster: ClusterConfig
  readonly accounts: MarketAccounts
  readonly user: PublicKey
}

function requireQuoteTokenProgram(accounts: MarketAccounts): MarketAccounts {
  const program = accounts.quoteTokenProgram.toBase58()
  if (!QUOTE_TOKEN_PROGRAMS.includes(program)) {
    throw new TypeError(`accounts.quoteTokenProgram must be the SPL Token or Token-2022 program, got ${program}`)
  }
  return accounts
}

function requireSwapContext(p: unknown, builder: string): SwapContext {
  requireObject(p, `${builder} params`)
  const params = p as BuyParams | SellParams
  const cluster = requireCluster(params.cluster)
  const accounts = requireQuoteTokenProgram(requireMarketAccounts(params.accounts))
  return { cluster, accounts, user: requireKey(params.user, 'user') }
}

/** Optional buy referrer: null when absent (undefined) or a self-referral, which is ignored; otherwise a PublicKey. */
function optionalReferrer(value: unknown, user: PublicKey): PublicKey | null {
  if (value === undefined) return null
  const referrer = requireKey(value, 'referrer')
  return referrer.toBase58() === user.toBase58() ? null : referrer
}

/** What a referrer adds to a buy: the idempotent creation of its quote ATA (user pays) and that ATA as remaining account. */
interface ReferralParts {
  readonly createAta: readonly TransactionInstruction[]
  readonly remaining: readonly AccountMeta[]
}

const NO_REFERRAL: ReferralParts = Object.freeze({ createAta: Object.freeze([]), remaining: Object.freeze([]) })

function referralParts(accounts: MarketAccounts, user: PublicKey, referrer: PublicKey | null): ReferralParts {
  if (referrer === null) return NO_REFERRAL
  const referral = referrerQuoteAtaOf(accounts, referrer)
  return {
    createAta: [createAssociatedTokenAccountIdempotentInstruction(user, referral, referrer, accounts.quoteMint, accounts.quoteTokenProgram)],
    remaining: [writableMeta(referral)],
  }
}

/**
 * The DBC swap accounts that follow `buffer_vault` in the router's `Swap` and `AutoExit` structs (pool authority
 * through system program), then the hook's remaining accounts.
 */
function dbcSwapAndHookMetas(cluster: ClusterConfig, accounts: MarketAccounts): AccountMeta[] {
  return [
    readonlyMeta(deriveDbcPoolAuthority()),
    readonlyMeta(accounts.config),
    writableMeta(accounts.pool),
    writableMeta(accounts.baseVault),
    writableMeta(accounts.quoteVault),
    writableMeta(accounts.baseMint),
    readonlyMeta(accounts.quoteMint),
    readonlyMeta(TOKEN_2022_PROGRAM_ID),
    readonlyMeta(accounts.quoteTokenProgram),
    readonlyMeta(deriveDbcEventAuthority()),
    readonlyMeta(cluster.dbcProgramId),
    readonlyMeta(SystemProgram.programId),
    // remaining accounts: [extra-account-metas, instructions sysvar, hook program]
    readonlyMeta(findExtraAccountMetasPda(accounts.baseMint, cluster.hookProgramId)),
    readonlyMeta(SYSVAR_INSTRUCTIONS_PUBKEY),
    readonlyMeta(cluster.hookProgramId),
  ]
}

/**
 * Router `Swap` accounts shared by buy and sell, then the hook's remaining accounts, then `extraRemaining` (a buy's
 * optional referral token account, the 4th remaining account; a sell takes none).
 */
function routerSwapInstruction(
  { cluster, accounts, user }: SwapContext,
  data: Buffer,
  extraRemaining: readonly AccountMeta[] = [],
): TransactionInstruction {
  const keys: AccountMeta[] = [
    signerMeta(user, true),
    writableMeta(accounts.market),
    writableMeta(findPositionPda(accounts.market, user, cluster.routerProgramId)),
    writableMeta(quoteAtaOf(accounts, user)),
    writableMeta(baseAtaOf(accounts, user)),
    writableMeta(accounts.bufferVault),
    ...dbcSwapAndHookMetas(cluster, accounts),
    ...extraRemaining,
  ]
  return new TransactionInstruction({ programId: cluster.routerProgramId, keys, data })
}

/* ---------- builders ---------- */

/**
 * Buy through the router: idempotently creates the user's quote and base (Token-2022) ATAs, wraps exactly
 * `amountIn` lamports first when the quote mint is native SOL, then calls the router `buy`.
 *
 * With a `referrer` other than the user, the user also idempotently creates the referrer's canonical quote ATA
 * (under the quote token program, off-curve owners allowed) right before the buy, and the buy names that ATA as its
 * 4th remaining account (writable, not a signer), where DBC pays its referral cut. A self-referral is ignored.
 *
 * @throws TypeError when `referrer` is present but not a PublicKey.
 */
export function buyInstructions(p: BuyParams): TransactionInstruction[] {
  const context = requireSwapContext(p, 'buyInstructions')
  const amountIn = requireU64(p.amountIn, 'amountIn', 1n)
  const minOut = requireU64(p.minOut, 'minOut', 0n)
  const { accounts, user } = context
  const referral = referralParts(accounts, user, optionalReferrer(p.referrer, user))
  const quoteAta = quoteAtaOf(accounts, user)
  const createAtas = [
    createAssociatedTokenAccountIdempotentInstruction(user, quoteAta, user, accounts.quoteMint, accounts.quoteTokenProgram),
    createAssociatedTokenAccountIdempotentInstruction(user, baseAtaOf(accounts, user), user, accounts.baseMint, TOKEN_2022_PROGRAM_ID),
  ]
  const wrapSol = isNativeQuote(accounts)
    ? [
        SystemProgram.transfer({ fromPubkey: user, toPubkey: quoteAta, lamports: amountIn }),
        createSyncNativeInstruction(quoteAta, accounts.quoteTokenProgram),
      ]
    : []
  const buy = routerSwapInstruction(context, encodeData(DISCRIMINATORS.buy, [amountIn, minOut]), referral.remaining)
  return [...createAtas, ...wrapSol, ...referral.createAta, buy]
}

/**
 * Exit at cost through the router: idempotently creates the user's quote ATA (the refund lands there, and an earlier
 * unwrap may have closed it), calls the router `sell`, then closes that ATA to unwrap the refund to SOL when
 * `unwrapSol` is set and the quote is native.
 */
export function sellInstructions(p: SellParams): TransactionInstruction[] {
  const context = requireSwapContext(p, 'sellInstructions')
  const tokens = requireU64(p.tokens, 'tokens', 1n)
  if (typeof p.unwrapSol !== 'boolean') throw new TypeError(`unwrapSol must be a boolean, got ${typeof p.unwrapSol}`)
  const { accounts, user } = context
  const quoteAta = quoteAtaOf(accounts, user)
  const createQuoteAta = createAssociatedTokenAccountIdempotentInstruction(user, quoteAta, user, accounts.quoteMint, accounts.quoteTokenProgram)
  const sell = routerSwapInstruction(context, encodeData(DISCRIMINATORS.sell, [tokens]))
  const unwrapSol = p.unwrapSol && isNativeQuote(accounts)
    ? [createCloseAccountInstruction(quoteAta, user, user, [], accounts.quoteTokenProgram)]
    : []
  return [createQuoteAta, sell, ...unwrapSol]
}

/** Permissionless once the curve is complete: snapshots the buffer surplus and the open basis. */
export function finalizeInstruction(p: FinalizeParams): TransactionInstruction {
  requireObject(p, 'finalizeInstruction params')
  const cluster = requireCluster(p.cluster)
  const keys = [
    writableMeta(requireKey(p.market, 'market')),
    readonlyMeta(requireKey(p.pool, 'pool')),
    readonlyMeta(requireKey(p.bufferVault, 'bufferVault')),
  ]
  return new TransactionInstruction({ programId: cluster.routerProgramId, keys, data: encodeData(DISCRIMINATORS.finalize) })
}

/** Permissionless claim: `cranker` signs; the share goes to the owner's canonical quote ATA, the rent to the owner. */
export function claimSurplusInstruction(p: ClaimParams): TransactionInstruction {
  requireObject(p, 'claimSurplusInstruction params')
  const cluster = requireCluster(p.cluster)
  const accounts = requireMarketAccounts(p.accounts)
  const cranker = requireKey(p.cranker, 'cranker')
  const owner = requireKey(p.owner, 'owner')
  const keys = [
    signerMeta(cranker, false),
    writableMeta(owner),
    writableMeta(accounts.market),
    writableMeta(findPositionPda(accounts.market, owner, cluster.routerProgramId)),
    writableMeta(quoteAtaOf(accounts, owner)),
    writableMeta(accounts.bufferVault),
    readonlyMeta(accounts.quoteMint),
    readonlyMeta(accounts.quoteTokenProgram),
  ]
  return new TransactionInstruction({ programId: cluster.routerProgramId, keys, data: encodeData(DISCRIMINATORS.claimSurplus) })
}

/** Opens the router market (and its quote buffer vault) for a DBC transfer-hook pool. */
export function initMarketInstruction(p: InitMarketParams): TransactionInstruction {
  requireObject(p, 'initMarketInstruction params')
  const cluster = requireCluster(p.cluster)
  const pool = requireKey(p.pool, 'pool')
  const market = findMarketPda(pool, cluster.routerProgramId)
  const keys = [
    signerMeta(requireKey(p.payer, 'payer'), true),
    readonlyMeta(pool),
    readonlyMeta(requireKey(p.config, 'config')),
    readonlyMeta(requireKey(p.quoteMint, 'quoteMint')),
    writableMeta(market),
    writableMeta(findBufferPda(market, cluster.routerProgramId)),
    readonlyMeta(requireKey(p.quoteTokenProgram, 'quoteTokenProgram')),
    readonlyMeta(SystemProgram.programId),
  ]
  return new TransactionInstruction({ programId: cluster.routerProgramId, keys, data: encodeData(DISCRIMINATORS.initMarket) })
}

/** Permissionless: writes the hook's static extra-account list (the instructions sysvar) for a base mint. */
export function initExtraAccountMetasInstruction(
  payer: PublicKey,
  baseMint: PublicKey,
  hookProgramId: PublicKey = HOOK_PROGRAM_ID,
): TransactionInstruction {
  const hook = requireKey(hookProgramId, 'hookProgramId')
  const mint = requireKey(baseMint, 'baseMint')
  const keys = [
    signerMeta(requireKey(payer, 'payer'), true),
    writableMeta(findExtraAccountMetasPda(mint, hook)),
    readonlyMeta(mint),
    readonlyMeta(SystemProgram.programId),
  ]
  return new TransactionInstruction({ programId: hook, keys, data: encodeData(DISCRIMINATORS.initializeExtraAccountMetaList) })
}

/**
 * Owner enables or disables Auto-Exit of their position.
 *
 * deadline > 0n: approveChecked of the owner's canonical base ATA (Token-2022) to the market PDA for u64::MAX, then
 * `set_auto_exit(deadline)`. The u64::MAX allowance keeps later buys covered, so the crank always sells the whole
 * position. deadline 0n: `set_auto_exit(0)`, then revoke that ATA's delegate. The router rejects a non-zero
 * deadline that is not strictly after the chain clock (AutoExitDeadlineInPast).
 *
 * @throws when `accounts.market` is not the market PDA of `accounts.pool` (never approves another delegate).
 */
export function setAutoExitInstructions(p: SetAutoExitParams): TransactionInstruction[] {
  requireObject(p, 'setAutoExitInstructions params')
  const cluster = requireCluster(p.cluster)
  const accounts = requireMarketAccounts(p.accounts)
  const owner = requireKey(p.owner, 'owner')
  const deadline = requireDeadline(p.deadline)
  const market = requireMarketPda(cluster, accounts)
  const ownerBase = baseAtaOf(accounts, owner)
  const keys = [
    signerMeta(owner, false),
    readonlyMeta(market),
    writableMeta(findPositionPda(market, owner, cluster.routerProgramId)),
  ]
  // The deadline is an i64; a value in [0, i64::MAX] has the same little-endian bytes as the u64 encodeData writes.
  const setAutoExit = new TransactionInstruction({
    programId: cluster.routerProgramId, keys, data: encodeData(DISCRIMINATORS.setAutoExit, [deadline]),
  })
  if (deadline === AUTO_EXIT_DISABLED) {
    return [setAutoExit, createRevokeInstruction(ownerBase, owner, [], TOKEN_2022_PROGRAM_ID)]
  }
  const approve = createApproveCheckedInstruction(
    ownerBase, accounts.baseMint, market, owner, U64_MAX, BASE_TOKEN_DECIMALS, [], TOKEN_2022_PROGRAM_ID,
  )
  return [approve, setAutoExit]
}

/**
 * Permissionless once the owner's deadline has passed and while the curve is live: `cranker` signs and the market
 * PDA sells the whole position as the owner's token delegate. The refund lands in the owner's canonical quote ATA,
 * which must exist (prepend an idempotent ATA creation, paid by the cranker, if the owner may have closed it).
 */
export function autoExitInstruction(p: AutoExitParams): TransactionInstruction {
  requireObject(p, 'autoExitInstruction params')
  const cluster = requireCluster(p.cluster)
  const accounts = requireQuoteTokenProgram(requireMarketAccounts(p.accounts))
  const cranker = requireKey(p.cranker, 'cranker')
  const owner = requireKey(p.owner, 'owner')
  const keys = [
    signerMeta(cranker, false),
    readonlyMeta(owner),
    writableMeta(accounts.market),
    writableMeta(findPositionPda(accounts.market, owner, cluster.routerProgramId)),
    writableMeta(quoteAtaOf(accounts, owner)),
    writableMeta(baseAtaOf(accounts, owner)),
    writableMeta(accounts.bufferVault),
    ...dbcSwapAndHookMetas(cluster, accounts),
  ]
  return new TransactionInstruction({ programId: cluster.routerProgramId, keys, data: encodeData(DISCRIMINATORS.autoExit) })
}
