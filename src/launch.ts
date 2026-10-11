/**
 * Zero-PvP launch: the DBC config preset and the transactions that create config, pool and router market.
 *
 * Preset rules (docs/trucee-plan.md §Preset rules): no creator token allocation (no locked vesting); a static,
 * quote-collected fee (the router's read_config rejects fee schedulers, rate limiters and dynamic fees); a Token-2022
 * base whose transfer hook is zpvp_hook; DAMM v2 migration. Retention Fee / Leftover are not built, so the fee claimer
 * and the leftover receiver are plain wallets chosen by the caller, never a Trucee PDA.
 */
import { Buffer } from 'buffer'
import {
  Keypair,
  PACKET_DATA_SIZE,
  PublicKey,
  SystemProgram,
  Transaction,
  type AccountInfo,
  type AccountMeta,
  type BlockhashWithExpiryBlockHeight,
  type Commitment,
  type Connection,
  type TransactionInstruction,
} from '@solana/web3.js'
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token'
import {
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  MAX_FEE_BPS,
  MIN_FEE_BPS,
  MigrationFeeOption,
  MigrationOption,
  TokenAuthorityOption,
  TokenDecimal,
  TokenType,
  buildCurve,
  createDbcProgram,
  deriveDbcEventAuthority,
  deriveDbcPoolAddress,
  deriveDbcPoolAuthority,
  deriveDbcTokenVaultAddress,
  validateConfigParameters,
  type BuildCurveParams,
  type ConfigParameters,
  type ConfigWithTransferHook,
  type DynamicCurveProgram,
  type TransferHookPool,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import { decodeMarket } from './accounts.js'
import { buyInstructions, initExtraAccountMetasInstruction, initMarketInstruction } from './instructions.js'
import { findBufferPda, findExtraAccountMetasPda, findMarketPda } from './pda.js'
import type { ClusterConfig, LaunchParams, LaunchPlan, MarketAccounts, PresetOptions, QuoteMintInfo } from './types.js'

/** Base token decimals of every Zero-PvP launch (mirrors litesvm-diff/src/fixture.ts). */
const BASE_DECIMALS = TokenDecimal.SIX
const BASE_UNIT = 10n ** BigInt(BASE_DECIMALS)
/** 1_000_000_000 tokens, in raw base units like every SDK amount. */
const DEFAULT_TOTAL_TOKEN_SUPPLY = 1_000_000_000n * BASE_UNIT
const DEFAULT_PERCENTAGE_SUPPLY_ON_MIGRATION = 20
/** All migration LP goes to the partner side and is locked forever; nothing to the creator. */
const PARTNER_PERMANENT_LOCKED_LIQUIDITY_PERCENTAGE = 100
const MAX_PERCENTAGE = 100
/** Metaplex-style metadata limits in UTF-8 bytes; they also keep the pool transaction within one packet. */
const MAX_NAME_BYTES = 32
const MAX_SYMBOL_BYTES = 10
const MAX_URI_BYTES = 200
/** The initial buy shares the transaction that opens the market, so it is the pool's first possible trade. */
const INITIAL_BUY_MIN_OUT = 0n

/** A resume reads at 'confirmed' so a retry right after a failed transaction sees the accounts that just landed. */
const LAUNCH_ACCOUNTS_COMMITMENT: Commitment = 'confirmed'

const U8_MAX = 255
const U64_MAX = 2n ** 64n - 1n
const PUBLIC_KEY_LENGTH = 32
const SECRET_KEY_LENGTH = 64

/** Validated PresetOptions with defaults applied. */
interface Preset {
  readonly quote: QuoteMintInfo
  readonly migrationQuoteThreshold: bigint
  readonly feeBps: number
  readonly feeClaimer: PublicKey
  readonly leftoverReceiver: PublicKey
  readonly totalTokenSupply: bigint
  readonly percentageSupplyOnMigration: number
}

/* ---------- input validation ---------- */

function requireObject(value: unknown, name: string): void {
  if (typeof value !== 'object' || value === null) throw new TypeError(`${name} must be an object`)
}

/** Duck-typed so keys from another @solana/web3.js copy are accepted; returns this copy's PublicKey. */
function requireKey(value: unknown, name: string): PublicKey {
  if (typeof (value as { toBytes?: unknown } | null | undefined)?.toBytes !== 'function') {
    throw new TypeError(`${name} must be a PublicKey`)
  }
  const bytes = (value as PublicKey).toBytes()
  if (bytes.length !== PUBLIC_KEY_LENGTH) throw new TypeError(`${name} must be a PublicKey of ${PUBLIC_KEY_LENGTH} bytes, got ${bytes.length}`)
  return new PublicKey(bytes)
}

/** An on-curve address: fees or leftovers sent to a PDA could only be claimed by its program. */
function requireWallet(value: unknown, name: string): PublicKey {
  const key = requireKey(value, name)
  if (!PublicKey.isOnCurve(key.toBytes())) throw new RangeError(`${name} must be a wallet address, got the off-curve (PDA) ${key.toBase58()}`)
  return key
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Optional; duck-typed like requireKey and rebuilt from the secret key, which checks it against its public half. */
function requireOptionalKeypair(value: unknown, name: string): Keypair | undefined {
  if (value === undefined) return undefined
  const secretKey = (value as { secretKey?: unknown } | null)?.secretKey
  if (!(secretKey instanceof Uint8Array) || secretKey.length !== SECRET_KEY_LENGTH) {
    throw new TypeError(`${name} must be a Keypair with a ${SECRET_KEY_LENGTH}-byte secret key`)
  }
  try {
    return Keypair.fromSecretKey(secretKey)
  } catch (error) {
    throw new TypeError(`${name} must be a valid Keypair: ${errorMessage(error)}`, { cause: error })
  }
}

function requireU64(value: unknown, name: string, min: bigint): bigint {
  if (typeof value !== 'bigint') throw new TypeError(`${name} must be a bigint in raw base units, got ${typeof value}`)
  if (value < min || value > U64_MAX) throw new RangeError(`${name} must be between ${min} and ${U64_MAX}, got ${value}`)
  return value
}

function requireInteger(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer between ${min} and ${max}, got ${String(value)}`)
  }
  return value
}

/** UTF-8 length, the unit DBC stores metadata strings in. */
function requireText(value: unknown, name: string, minBytes: number, maxBytes: number): string {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string, got ${typeof value}`)
  const bytes = Buffer.byteLength(value, 'utf8')
  if (bytes < minBytes || bytes > maxBytes) {
    const range = minBytes === 0 ? `at most ${maxBytes}` : `${minBytes} to ${maxBytes}`
    throw new RangeError(`${name} must be ${range} bytes (UTF-8), got ${bytes}`)
  }
  return value
}

function requireQuote(value: unknown): QuoteMintInfo {
  requireObject(value, 'quote')
  const quote = value as QuoteMintInfo
  requireKey(quote.mint, 'quote.mint')
  requireKey(quote.tokenProgram, 'quote.tokenProgram')
  requireInteger(quote.decimals, 'quote.decimals', 0, U8_MAX)
  requireU64(quote.maxMigrationQuoteThreshold, 'quote.maxMigrationQuoteThreshold', 1n)
  if (quote.tokenBadge !== null) requireKey(quote.tokenBadge, 'quote.tokenBadge')
  return quote
}

function requirePercentageOnMigration(value: unknown): number {
  if (value === undefined) return DEFAULT_PERCENTAGE_SUPPLY_ON_MIGRATION
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value >= MAX_PERCENTAGE) {
    throw new RangeError(`percentageSupplyOnMigration must be a number strictly between 0 and ${MAX_PERCENTAGE}, got ${String(value)}`)
  }
  return value
}

function requireTotalTokenSupply(value: unknown): bigint {
  if (value === undefined) return DEFAULT_TOTAL_TOKEN_SUPPLY
  const supply = requireU64(value, 'totalTokenSupply', BASE_UNIT)
  if (supply % BASE_UNIT !== 0n) throw new RangeError(`totalTokenSupply must be whole tokens (a multiple of ${BASE_UNIT} raw units), got ${supply}`)
  return supply
}

function requirePreset(opts: unknown): Preset {
  requireObject(opts, 'preset options')
  const o = opts as PresetOptions
  const quote = requireQuote(o.quote)
  const migrationQuoteThreshold = requireU64(o.migrationQuoteThreshold, 'migrationQuoteThreshold', 1n)
  if (migrationQuoteThreshold > quote.maxMigrationQuoteThreshold) {
    throw new RangeError(
      `migrationQuoteThreshold ${migrationQuoteThreshold} exceeds the ${quote.symbol} cap ${quote.maxMigrationQuoteThreshold} (router launch cap)`,
    )
  }
  return Object.freeze({
    quote,
    migrationQuoteThreshold,
    feeBps: requireInteger(o.feeBps, 'feeBps', MIN_FEE_BPS, MAX_FEE_BPS),
    feeClaimer: requireWallet(o.feeClaimer, 'feeClaimer'),
    leftoverReceiver: requireWallet(o.leftoverReceiver, 'leftoverReceiver'),
    totalTokenSupply: requireTotalTokenSupply(o.totalTokenSupply),
    percentageSupplyOnMigration: requirePercentageOnMigration(o.percentageSupplyOnMigration),
  })
}

/* ---------- preset ---------- */

/** `raw / 10^decimals` as a number built from its exact decimal string (buildCurve takes UI amounts). */
function toUiAmount(raw: bigint, decimals: number): number {
  const unit = 10n ** BigInt(decimals)
  const fraction = (raw % unit).toString().padStart(decimals, '0').replace(/0+$/, '')
  return Number(fraction === '' ? `${raw / unit}` : `${raw / unit}.${fraction}`)
}

function assertExact(actual: { toString(): string } | undefined, expected: bigint, name: string): void {
  if (actual?.toString() !== expected.toString()) {
    throw new RangeError(`${name} ${expected} is not representable by the DBC curve builder (got ${String(actual)})`)
  }
}

function curveParams(preset: Preset): BuildCurveParams {
  const { feeBps } = preset
  return {
    token: {
      tokenType: TokenType.Token2022, tokenBaseDecimal: BASE_DECIMALS, tokenQuoteDecimal: preset.quote.decimals,
      tokenAuthorityOption: TokenAuthorityOption.Immutable, totalTokenSupply: toUiAmount(preset.totalTokenSupply, BASE_DECIMALS), leftover: 0,
    },
    fee: {
      // Equal start and end with zero periods: a static cliff fee, which is all the router's read_config accepts.
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
        feeSchedulerParam: { startingFeeBps: feeBps, endingFeeBps: feeBps, numberOfPeriod: 0, totalDuration: 0 },
      },
      dynamicFeeEnabled: false, collectFeeMode: CollectFeeMode.QuoteToken, creatorTradingFeePercentage: 0,
      poolCreationFee: 0, enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2, migrationFeeOption: MigrationFeeOption.FixedBps25,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
    },
    liquidityDistribution: {
      partnerPermanentLockedLiquidityPercentage: PARTNER_PERMANENT_LOCKED_LIQUIDITY_PERCENTAGE, partnerLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 0, creatorLiquidityPercentage: 0,
    },
    // No creator token allocation: creators buy on the same curve as everyone else.
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    activationType: ActivationType.Slot,
    percentageSupplyOnMigration: preset.percentageSupplyOnMigration,
    migrationQuoteThreshold: toUiAmount(preset.migrationQuoteThreshold, preset.quote.decimals),
  }
}

function zeroPvpConfigParameters(preset: Preset): ConfigParameters {
  // buildCurve leaves the reserved [u8; 2] padding empty; spell it out as the IDL declares it.
  const params: ConfigParameters = { ...buildCurve(curveParams(preset)), padding: [0, 0] }
  assertExact(params.migrationQuoteThreshold, preset.migrationQuoteThreshold, 'migrationQuoteThreshold')
  assertExact(params.tokenSupply?.preMigrationTokenSupply, preset.totalTokenSupply, 'totalTokenSupply')
  validateConfigParameters({ ...params, leftoverReceiver: preset.leftoverReceiver }, { isTransferHook: true })
  return params
}

/**
 * DBC ConfigParameters for a transfer-hook pool the router accepts: static cliff fee of `feeBps * 1e5` / 1e9
 * collected in quote, no scheduler periods, no dynamic fee, Token-2022 base (6 decimals), DAMM v2 migration, no
 * locked vesting. Defaults: 1_000_000_000 tokens (`totalTokenSupply` is in raw base units), 20% of supply on
 * migration. Throws when `migrationQuoteThreshold` exceeds `quote.maxMigrationQuoteThreshold`.
 */
export function buildZeroPvpConfigParameters(opts: PresetOptions): ConfigParameters {
  return zeroPvpConfigParameters(requirePreset(opts))
}

/* ---------- launch plan ---------- */

interface LaunchInputs {
  readonly connection: Connection
  readonly cluster: ClusterConfig
  readonly creator: PublicKey
  readonly name: string
  readonly symbol: string
  readonly uri: string
  readonly preset: Preset
  readonly initialBuy: bigint
  /** Set only when resuming an earlier plan. */
  readonly configKeypair: Keypair | undefined
  readonly baseMintKeypair: Keypair | undefined
}

/** The DBC instructions come from the DBC SDK's IDL, so the cluster must name that same DBC program. */
function requireCluster(value: unknown): ClusterConfig {
  requireObject(value, 'cluster')
  const cluster = value as ClusterConfig
  requireKey(cluster.routerProgramId, 'cluster.routerProgramId')
  requireKey(cluster.hookProgramId, 'cluster.hookProgramId')
  if (!requireKey(cluster.dbcProgramId, 'cluster.dbcProgramId').equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID)) {
    throw new RangeError(`cluster.dbcProgramId must be the DBC program ${DYNAMIC_BONDING_CURVE_PROGRAM_ID.toBase58()}`)
  }
  if (!Array.isArray(cluster.quoteMints)) throw new TypeError('cluster.quoteMints must be an array')
  return cluster
}

/** The cluster's own QuoteMintInfo (cap, decimals, programs, badge) for the preset's quote mint. */
function requireClusterQuote(cluster: ClusterConfig, quote: QuoteMintInfo): QuoteMintInfo {
  const mint = requireKey(quote.mint, 'quote.mint')
  const allowed = cluster.quoteMints.find((candidate) => requireKey(candidate.mint, 'cluster quote mint').equals(mint))
  if (allowed === undefined) throw new RangeError(`quote mint ${mint.toBase58()} is not allowed on ${String(cluster.cluster)}`)
  return allowed
}

function requireLaunchParams(p: unknown): LaunchInputs {
  requireObject(p, 'launch params')
  const params = p as LaunchParams
  if (typeof (params.connection as { getLatestBlockhash?: unknown } | undefined)?.getLatestBlockhash !== 'function') {
    throw new TypeError('connection must be a @solana/web3.js Connection')
  }
  const cluster = requireCluster(params.cluster)
  requireObject(params.preset, 'preset')
  const quote = requireClusterQuote(cluster, requireQuote(params.preset.quote))
  const configKeypair = requireOptionalKeypair(params.configKeypair, 'configKeypair')
  const baseMintKeypair = requireOptionalKeypair(params.baseMintKeypair, 'baseMintKeypair')
  if (configKeypair !== undefined && baseMintKeypair?.publicKey.equals(configKeypair.publicKey) === true) {
    throw new RangeError('configKeypair and baseMintKeypair must be different keys')
  }
  return {
    connection: params.connection,
    cluster,
    creator: requireKey(params.creator, 'creator'),
    name: requireText(params.name, 'name', 1, MAX_NAME_BYTES),
    symbol: requireText(params.symbol, 'symbol', 1, MAX_SYMBOL_BYTES),
    uri: requireText(params.uri, 'uri', 0, MAX_URI_BYTES),
    preset: requirePreset({ ...params.preset, quote }),
    initialBuy: params.initialBuy === undefined ? 0n : requireU64(params.initialBuy, 'initialBuy', 0n),
    configKeypair,
    baseMintKeypair,
  }
}

/** Runs one RPC call, naming `what` it fetched when it fails. */
async function fetchOrThrow<T>(what: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (error) {
    throw new Error(`buildLaunchPlan: could not fetch ${what}: ${errorMessage(error)}`, { cause: error })
  }
}

function recentBlockhash(connection: Connection): Promise<BlockhashWithExpiryBlockHeight> {
  return fetchOrThrow('a recent blockhash', () => connection.getLatestBlockhash())
}

/** Fee payer = creator; throws when the transaction cannot fit one packet with every signature present. */
function launchTransaction(label: string, payer: PublicKey, blockhash: BlockhashWithExpiryBlockHeight, ixs: readonly TransactionInstruction[]): Transaction {
  const tx = new Transaction({ feePayer: payer, ...blockhash }).add(...ixs)
  // Compiling fills one (empty) signature slot per required signer, so this is the signed wire size.
  const size = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length
  if (size > PACKET_DATA_SIZE) throw new RangeError(`${label} transaction is ${size} bytes, above the ${PACKET_DATA_SIZE}-byte limit`)
  return tx
}

interface LaunchAccounts extends MarketAccounts {
  readonly badge: readonly AccountMeta[]
}

function launchAccounts(inputs: LaunchInputs, config: PublicKey, baseMint: PublicKey): LaunchAccounts {
  const { cluster, preset: { quote } } = inputs
  const pool = deriveDbcPoolAddress(quote.mint, baseMint, config)
  const market = findMarketPda(pool, cluster.routerProgramId)
  return {
    market, pool, config, baseMint, quoteMint: quote.mint,
    baseVault: deriveDbcTokenVaultAddress(pool, baseMint),
    quoteVault: deriveDbcTokenVaultAddress(pool, quote.mint),
    bufferVault: findBufferPda(market, cluster.routerProgramId),
    quoteTokenProgram: quote.tokenProgram,
    // xStock quotes: DBC wants the quote's token badge as the first remaining account.
    badge: quote.tokenBadge === null ? [] : [{ pubkey: quote.tokenBadge, isSigner: false, isWritable: false }],
  }
}

/* ---------- resume: accounts that already exist ---------- */

/** Which launch accounts already exist on chain; a first build with fresh keypairs has none. */
interface ExistingAccounts {
  readonly config: boolean
  readonly pool: boolean
  readonly extraMetas: boolean
  readonly market: boolean
}

const NONE_EXIST: ExistingAccounts = Object.freeze({ config: false, pool: false, extraMetas: false, market: false })

type MaybeAccount = AccountInfo<Buffer> | null

/** [field, on-chain value, value this launch expects], both as display strings. */
type Expectation = readonly [field: string, actual: string, expected: string]

const keyText = (key: { toBase58(): string }): string => key.toBase58()

async function fetchLaunchAccounts(connection: Connection, addresses: readonly PublicKey[]): Promise<readonly MaybeAccount[]> {
  const infos: unknown = await fetchOrThrow('the launch accounts',
    () => connection.getMultipleAccountsInfo([...addresses], LAUNCH_ACCOUNTS_COMMITMENT))
  if (!Array.isArray(infos) || infos.length !== addresses.length) {
    const got = Array.isArray(infos) ? `${infos.length}` : typeof infos
    throw new Error(`buildLaunchPlan: expected ${addresses.length} accounts from getMultipleAccountsInfo, got ${got}`)
  }
  return infos as readonly MaybeAccount[]
}

/**
 * The account when `owner` holds it; null when it is missing or only holds lamports (a system account with no data,
 * which Anchor's init still accepts). Any other owner means the address is taken by something else.
 */
function ownedAccount(info: MaybeAccount | undefined, owner: PublicKey, label: string, address: PublicKey): MaybeAccount {
  if (info === undefined || info === null) return null
  const holder = keyText(info.owner)
  if (holder === SystemProgram.programId.toBase58() && info.data.length === 0) return null
  if (holder !== owner.toBase58()) {
    throw new Error(`buildLaunchPlan: ${label} ${address.toBase58()} is owned by ${holder}, not ${owner.toBase58()}`)
  }
  return info
}

function assertMatches(label: string, address: PublicKey, expectations: readonly Expectation[]): void {
  const mismatch = expectations.find(([, actual, expected]) => actual !== expected)
  if (mismatch === undefined) return
  const [field, actual, expected] = mismatch
  throw new Error(
    `buildLaunchPlan: existing ${label} ${address.toBase58()} has ${field} ${actual}, expected ${expected}; it does not belong to this launch`,
  )
}

function decodeDbc<T>(program: DynamicCurveProgram, name: 'configWithTransferHook' | 'transferHookPool', label: string, address: PublicKey, data: Buffer): T {
  try {
    return program.coder.accounts.decode<T>(name, data)
  } catch (error) {
    throw new Error(`buildLaunchPlan: existing ${label} ${address.toBase58()} is not a DBC transfer-hook ${label}: ${errorMessage(error)}`, { cause: error })
  }
}

/** The existing config must carry this launch's quote, wallets, threshold and hook. */
function checkConfig(inputs: LaunchInputs, program: DynamicCurveProgram, a: LaunchAccounts, data: Buffer): void {
  const { config, transferHookProgram } = decodeDbc<ConfigWithTransferHook>(program, 'configWithTransferHook', 'config', a.config, data)
  const { preset, cluster } = inputs
  assertMatches('config', a.config, [
    ['quote mint', keyText(config.quoteMint), keyText(a.quoteMint)],
    ['fee claimer', keyText(config.feeClaimer), keyText(preset.feeClaimer)],
    ['leftover receiver', keyText(config.leftoverReceiver), keyText(preset.leftoverReceiver)],
    ['migration quote threshold', config.migrationQuoteThreshold.toString(), preset.migrationQuoteThreshold.toString()],
    ['transfer hook program', keyText(transferHookProgram), keyText(cluster.hookProgramId)],
  ])
}

function checkPool(inputs: LaunchInputs, program: DynamicCurveProgram, a: LaunchAccounts, data: Buffer): void {
  const { poolState } = decodeDbc<TransferHookPool>(program, 'transferHookPool', 'pool', a.pool, data)
  assertMatches('pool', a.pool, [
    ['config', keyText(poolState.config), keyText(a.config)],
    ['base mint', keyText(poolState.baseMint), keyText(a.baseMint)],
    ['creator', keyText(poolState.creator), keyText(inputs.creator)],
  ])
}

function checkMarket(a: LaunchAccounts, data: Buffer): void {
  const market = decodeMarket(a.market, data)
  assertMatches('market', a.market, [
    ['pool', keyText(market.pool), keyText(a.pool)],
    ['config', keyText(market.config), keyText(a.config)],
    ['base mint', keyText(market.baseMint), keyText(a.baseMint)],
  ])
}

/** One getMultipleAccountsInfo over [config, pool, extra metas, market]; throws on an account of another launch. */
async function existingAccounts(inputs: LaunchInputs, program: DynamicCurveProgram, a: LaunchAccounts): Promise<ExistingAccounts> {
  const { cluster } = inputs
  const extraMetas = findExtraAccountMetasPda(a.baseMint, cluster.hookProgramId)
  const infos = await fetchLaunchAccounts(inputs.connection, [a.config, a.pool, extraMetas, a.market])
  const config = ownedAccount(infos[0], cluster.dbcProgramId, 'config', a.config)
  const pool = ownedAccount(infos[1], cluster.dbcProgramId, 'pool', a.pool)
  const metas = ownedAccount(infos[2], cluster.hookProgramId, 'hook extra-account-metas', extraMetas)
  const market = ownedAccount(infos[3], cluster.routerProgramId, 'market', a.market)
  if (config !== null) checkConfig(inputs, program, a, config.data)
  if (pool !== null) checkPool(inputs, program, a, pool.data)
  if (market !== null) checkMarket(a, market.data)
  return Object.freeze({ config: config !== null, pool: pool !== null, extraMetas: metas !== null, market: market !== null })
}

/* ---------- plan assembly ---------- */

async function dbcInstructions(
  inputs: LaunchInputs,
  program: DynamicCurveProgram,
  a: LaunchAccounts,
): Promise<[TransactionInstruction, TransactionInstruction]> {
  const { cluster, creator, preset } = inputs
  const eventAuthority = deriveDbcEventAuthority()
  const createConfig = program.methods.createConfigWithTransferHook(zeroPvpConfigParameters(preset))
    .accountsPartial({
      config: a.config, feeClaimer: preset.feeClaimer, leftoverReceiver: preset.leftoverReceiver, quoteMint: a.quoteMint,
      transferHookProgram: cluster.hookProgramId, payer: creator, eventAuthority,
    })
    .remainingAccounts([...a.badge])
    .instruction()
  const createPool = program.methods.initializeVirtualPoolWithToken2022TransferHook({ name: inputs.name, symbol: inputs.symbol, uri: inputs.uri })
    .accountsPartial({
      config: a.config, poolAuthority: deriveDbcPoolAuthority(), creator, baseMint: a.baseMint, quoteMint: a.quoteMint, pool: a.pool,
      baseVault: a.baseVault, quoteVault: a.quoteVault, transferHookProgram: cluster.hookProgramId, payer: creator,
      tokenQuoteProgram: a.quoteTokenProgram, tokenProgram: TOKEN_2022_PROGRAM_ID, eventAuthority,
    })
    .remainingAccounts([...a.badge])
    .instruction()
  return Promise.all([createConfig, createPool])
}

/** Hook extra-account-metas and router market inits that are still missing, then the creator's buy when initialBuy > 0. */
function openMarketInstructions(inputs: LaunchInputs, a: LaunchAccounts, existing: ExistingAccounts): TransactionInstruction[] {
  const { cluster, creator, initialBuy } = inputs
  const hookInit = existing.extraMetas ? [] : [initExtraAccountMetasInstruction(creator, a.baseMint, cluster.hookProgramId)]
  const marketInit = existing.market
    ? []
    : [initMarketInstruction({ cluster, payer: creator, pool: a.pool, config: a.config, quoteMint: a.quoteMint, quoteTokenProgram: a.quoteTokenProgram })]
  const buy = initialBuy > 0n
    ? buyInstructions({ cluster, accounts: a, user: creator, amountIn: initialBuy, minOut: INITIAL_BUY_MIN_OUT })
    : []
  return [...hookInit, ...marketInit, ...buy]
}

/** One launch transaction before it is built: its instructions and the extra signers it needs. */
interface LaunchStep {
  readonly label: string
  readonly instructions: readonly TransactionInstruction[]
  readonly signers: readonly Keypair[]
}

/**
 * Transactions that launch a Zero-PvP token, to send in order: [0] create the DBC config (extra signer: the config
 * keypair), [1] create the pool with metadata name/symbol/uri (extra signer: the base mint keypair), [2] init the
 * hook's extra-account-metas and the router market, plus the creator's buy when `initialBuy` > 0. Every transaction
 * has fee payer = creator and a recent blockhash, and fits one packet. The preset quote must be allowed by the
 * cluster, whose QuoteMintInfo (cap, programs, badge) is authoritative. Throws on invalid input, including a uri
 * above 200 bytes or a threshold above the quote cap.
 *
 * Resume: pass the first plan's config keypair (its signers[0][0]) as `configKeypair` and its base-mint keypair
 * (signers[1][0]) as `baseMintKeypair`. The plan then fetches the config, pool, extra-metas and market in one
 * getMultipleAccountsInfo call and leaves out what already exists (the hook init and init_market are permissionless,
 * so a third party may have sent them). After a full launch it holds just the buy, or no transaction when
 * `initialBuy` is 0. `signers[i]` stays aligned with the transactions that remain. Throws when an existing account belongs to another launch: a config with another quote,
 * wallets, threshold or hook, a pool with another config, base mint or creator, or a market with another pool,
 * config or base mint. A first build with fresh keypairs makes no account request, since nothing can exist yet.
 */
export async function buildLaunchPlan(p: LaunchParams): Promise<LaunchPlan> {
  const inputs = requireLaunchParams(p)
  const configKeypair = inputs.configKeypair ?? Keypair.generate()
  const baseMintKeypair = inputs.baseMintKeypair ?? Keypair.generate()
  const accounts = launchAccounts(inputs, configKeypair.publicKey, baseMintKeypair.publicKey)
  const { program } = createDbcProgram(inputs.connection)
  const isResume = inputs.configKeypair !== undefined || inputs.baseMintKeypair !== undefined
  const existing = isResume ? await existingAccounts(inputs, program, accounts) : NONE_EXIST
  const [createConfig, createPool] = await dbcInstructions(inputs, program, accounts)
  const openMarket = openMarketInstructions(inputs, accounts, existing)
  const steps: readonly LaunchStep[] = [
    ...(existing.config ? [] : [{ label: 'create config', instructions: [createConfig], signers: [configKeypair] }]),
    ...(existing.pool ? [] : [{ label: 'create pool', instructions: [createPool], signers: [baseMintKeypair] }]),
    ...(openMarket.length === 0 ? [] : [{ label: 'open market', instructions: openMarket, signers: [] }]),
  ]
  const blockhash = await recentBlockhash(inputs.connection)
  const { creator } = inputs
  return Object.freeze({
    transactions: steps.map((step) => launchTransaction(step.label, creator, blockhash, step.instructions)),
    signers: steps.map((step) => [...step.signers]),
    config: accounts.config,
    pool: accounts.pool,
    baseMint: accounts.baseMint,
    market: accounts.market,
  })
}
