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
  Transaction,
  type AccountMeta,
  type BlockhashWithExpiryBlockHeight,
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
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import { buyInstructions, initExtraAccountMetasInstruction, initMarketInstruction } from './instructions.js'
import { findBufferPda, findMarketPda } from './pda.js'
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

const U8_MAX = 255
const U64_MAX = 2n ** 64n - 1n
const PUBLIC_KEY_LENGTH = 32

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
  return {
    connection: params.connection,
    cluster,
    creator: requireKey(params.creator, 'creator'),
    name: requireText(params.name, 'name', 1, MAX_NAME_BYTES),
    symbol: requireText(params.symbol, 'symbol', 1, MAX_SYMBOL_BYTES),
    uri: requireText(params.uri, 'uri', 0, MAX_URI_BYTES),
    preset: requirePreset({ ...params.preset, quote }),
    initialBuy: params.initialBuy === undefined ? 0n : requireU64(params.initialBuy, 'initialBuy', 0n),
  }
}

async function recentBlockhash(connection: Connection): Promise<BlockhashWithExpiryBlockHeight> {
  try {
    return await connection.getLatestBlockhash()
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`buildLaunchPlan: could not fetch a recent blockhash: ${reason}`, { cause: error })
  }
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

async function dbcInstructions(inputs: LaunchInputs, a: LaunchAccounts): Promise<[TransactionInstruction, TransactionInstruction]> {
  const { program } = createDbcProgram(inputs.connection)
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

/** Hook extra-account-metas, router market and (when initialBuy > 0) the creator's buy, in one transaction. */
function openMarketInstructions(inputs: LaunchInputs, a: LaunchAccounts): TransactionInstruction[] {
  const { cluster, creator, initialBuy } = inputs
  const buy = initialBuy > 0n
    ? buyInstructions({ cluster, accounts: a, user: creator, amountIn: initialBuy, minOut: INITIAL_BUY_MIN_OUT })
    : []
  return [
    initExtraAccountMetasInstruction(creator, a.baseMint, cluster.hookProgramId),
    initMarketInstruction({ cluster, payer: creator, pool: a.pool, config: a.config, quoteMint: a.quoteMint, quoteTokenProgram: a.quoteTokenProgram }),
    ...buy,
  ]
}

/**
 * Transactions that launch a Zero-PvP token, to send in order: [0] create the DBC config (extra signer: the config
 * keypair), [1] create the pool with metadata name/symbol/uri (extra signer: the base mint keypair), [2] init the
 * hook's extra-account-metas and the router market, plus the creator's buy when `initialBuy` > 0. Every transaction
 * has fee payer = creator and a recent blockhash, and fits one packet. The preset quote must be allowed by the
 * cluster, whose QuoteMintInfo (cap, programs, badge) is authoritative. Throws on invalid input, including a uri
 * above 200 bytes or a threshold above the quote cap.
 */
export async function buildLaunchPlan(p: LaunchParams): Promise<LaunchPlan> {
  const inputs = requireLaunchParams(p)
  const configKeypair = Keypair.generate()
  const baseMintKeypair = Keypair.generate()
  const accounts = launchAccounts(inputs, configKeypair.publicKey, baseMintKeypair.publicKey)
  const [createConfig, createPool] = await dbcInstructions(inputs, accounts)
  const blockhash = await recentBlockhash(inputs.connection)
  const { creator } = inputs
  return Object.freeze({
    transactions: [
      launchTransaction('create config', creator, blockhash, [createConfig]),
      launchTransaction('create pool', creator, blockhash, [createPool]),
      launchTransaction('open market', creator, blockhash, openMarketInstructions(inputs, accounts)),
    ],
    signers: [[configKeypair], [baseMintKeypair], []],
    config: accounts.config,
    pool: accounts.pool,
    baseMint: accounts.baseMint,
    market: accounts.market,
  })
}
