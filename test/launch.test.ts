/**
 * SDK-03: Zero-PvP DBC preset and launch plan. Unit tests pin the preset rules and the plan's shape; the LiteSVM
 * tests execute a plan against DBC, zpvp_hook and the capped router (wSOL quote, threshold from
 * litesvm-diff/out/scenario_tiny.json).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Buffer } from 'buffer'
import BN from 'bn.js'
import {
  Connection,
  Keypair,
  PublicKey,
  type BlockhashWithExpiryBlockHeight,
  type Transaction,
  type TransactionInstruction,
} from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import { DYNAMIC_BONDING_CURVE_PROGRAM_ID, deriveDbcPoolAddress, getTotalSupplyFromCurve } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { FailedTransactionMetadata, type LiteSVM } from 'litesvm'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  buildLaunchPlan,
  buildZeroPvpConfigParameters,
  decodeMarket,
  decodePosition,
  findBufferPda,
  findExtraAccountMetasPda,
  findMarketPda,
  findPositionPda,
  getClusterConfig,
} from '../src/index.js'
import type { ClusterConfig, LaunchParams, LaunchPlan, PresetOptions, QuoteMintInfo } from '../src/index.js'
import { CONFIG_MIGRATION_QUOTE_THRESHOLD_OFFSET, isCurveComplete, readU64, setupMarket } from './helpers/litesvm.js'

const PACKET_DATA_SIZE = 1232
const BASE_DECIMALS = 6
const ONE_BILLION_TOKENS = 1_000_000_000n * 10n ** BigInt(BASE_DECIMALS)
const FEE_BPS = 100
const CREATOR_LAMPORTS = 10_000_000_000n // 10 SOL
const INITIAL_BUY = 2_000_000n // 0.002 SOL: far below the Anti-Whale cap (20% of swap_base_amount)

const SCENARIO_PATH = fileURLToPath(new URL('../../litesvm-diff/out/scenario_tiny.json', import.meta.url))
const SCENARIO_THRESHOLD = BigInt((JSON.parse(readFileSync(SCENARIO_PATH, 'utf8')) as [{ migration_quote_threshold: string }])[0]
  .migration_quote_threshold)

const localnet = getClusterConfig('localnet')
const mainnet = getClusterConfig('mainnet-beta')
const quoteOf = (cluster: ClusterConfig, symbol: QuoteMintInfo['symbol']): QuoteMintInfo => {
  const quote = cluster.quoteMints.find((q) => q.symbol === symbol)
  if (quote === undefined) throw new Error(`${cluster.cluster} has no ${symbol} quote`)
  return quote
}
const SOL = quoteOf(localnet, 'SOL')
const TSLAX = quoteOf(mainnet, 'TSLAx')

const presetOf = (overrides: Partial<PresetOptions> = {}): PresetOptions => ({
  quote: SOL,
  migrationQuoteThreshold: SCENARIO_THRESHOLD,
  feeBps: FEE_BPS,
  feeClaimer: Keypair.generate().publicKey,
  leftoverReceiver: Keypair.generate().publicKey,
  ...overrides,
})

/** Real Connection to a dead port: any RPC call except the overridden blockhash fails fast. */
class FixedBlockhashConnection extends Connection {
  constructor(private readonly nextBlockhash: () => string) {
    super('http://127.0.0.1:1')
  }

  override async getLatestBlockhash(): Promise<BlockhashWithExpiryBlockHeight> {
    return { blockhash: this.nextBlockhash(), lastValidBlockHeight: 1_000 }
  }
}

const offlineConnection = (): Connection => {
  const blockhash = Keypair.generate().publicKey.toBase58()
  return new FixedBlockhashConnection(() => blockhash)
}

const launchParams = (overrides: Partial<LaunchParams> = {}): LaunchParams => ({
  connection: offlineConnection(),
  cluster: localnet,
  creator: Keypair.generate().publicKey,
  name: 'Trucee',
  symbol: 'TRC',
  uri: 'https://trucee.test/meta.json',
  preset: presetOf(),
  ...overrides,
})

const bn = (value: bigint | number): string => new BN(value.toString()).toString()
const keys = (ixs: readonly TransactionInstruction[]) => ixs.map((ix) => ix.programId.toBase58())
const signerKeys = (plan: LaunchPlan, i: number): string[] => (plan.signers[i] ?? []).map((k) => k.publicKey.toBase58())
/** Wire size with every required signature slot present (unsigned slots are zero-filled). */
const wireSize = (tx: Transaction): number => tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length

describe('buildZeroPvpConfigParameters', () => {
  it('builds a static quote-collected fee: cliff = feeBps * 1e5, no scheduler periods, no dynamic fee', () => {
    const params = buildZeroPvpConfigParameters(presetOf({ feeBps: 250 }))

    expect(params.poolFees.baseFee.cliffFeeNumerator.toString()).toBe(bn(250 * 100_000))
    expect(params.poolFees.baseFee.firstFactor).toBe(0)
    expect(params.poolFees.baseFee.secondFactor.toString()).toBe('0')
    expect(params.poolFees.baseFee.thirdFactor.toString()).toBe('0')
    expect(params.poolFees.baseFee.baseFeeMode).toBe(0)
    expect(params.poolFees.dynamicFee).toBeNull()
    expect(params.collectFeeMode).toBe(0)
    expect(params.enableFirstSwapWithMinFee).toBe(false)
  })

  it('pins the Zero-PvP token and migration rules (Token-2022, DAMM v2, no migration fee, dynamic supply, no creator allocation)', () => {
    const params = buildZeroPvpConfigParameters(presetOf())

    expect(params).toMatchObject({
      tokenType: 1, tokenDecimal: BASE_DECIMALS, migrationOption: 1, activationType: 0, tokenUpdateAuthority: 1,
      partnerLiquidityPercentage: 0, partnerPermanentLockedLiquidityPercentage: 100,
      creatorLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 0, creatorTradingFeePercentage: 0,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 }, tokenSupply: null, padding: [0, 0],
    })
    expect(params.partnerLiquidityVestingInfo?.vestingPercentage ?? 0).toBe(0)
    expect(params.creatorLiquidityVestingInfo?.vestingPercentage ?? 0).toBe(0)
    expect(params.poolCreationFee.toString()).toBe('0')
    const vesting = params.lockedVesting
    ;[vesting.amountPerPeriod, vesting.cliffDurationFromMigrationTime, vesting.frequency, vesting.numberOfPeriod, vesting.cliffUnlockAmount]
      .forEach((value) => expect(value.toString()).toBe('0'))
    expect(params.migrationQuoteThreshold.toString()).toBe(SCENARIO_THRESHOLD.toString())
    expect(params.curve.length).toBeGreaterThan(0)
  })

  it('defaults to 1_000_000_000 tokens and 20% of supply on migration, with dynamic supply', () => {
    const defaults = buildZeroPvpConfigParameters(presetOf())
    const explicit = buildZeroPvpConfigParameters(presetOf({ totalTokenSupply: ONE_BILLION_TOKENS, percentageSupplyOnMigration: 20 }))
    const otherShape = buildZeroPvpConfigParameters(presetOf({ percentageSupplyOnMigration: 30 }))

    expect(defaults.tokenSupply).toBeNull()
    expect(JSON.stringify(defaults)).toBe(JSON.stringify(explicit))
    expect(otherShape.sqrtStartPrice.toString()).not.toBe(defaults.sqrtStartPrice.toString())
  })

  it.each([
    ['the default supply', undefined, ONE_BILLION_TOKENS],
    ['a custom supply', 500_000_000n * 10n ** BigInt(BASE_DECIMALS), 500_000_000n * 10n ** BigInt(BASE_DECIMALS)],
  ])('shapes the curve so DBC mints %s in raw base units, with the supply left dynamic', (_label, totalTokenSupply, minted) => {
    const params = buildZeroPvpConfigParameters(presetOf({ totalTokenSupply }))
    // What DBC mints for a dynamic-supply pool: the swap amount with its buffer plus the migration amount.
    const dynamicSupply = getTotalSupplyFromCurve(params.migrationQuoteThreshold, params.sqrtStartPrice, params.curve, params.lockedVesting,
      params.migrationOption, new BN(0), params.migrationFee.feePercentage)

    expect(params.tokenSupply).toBeNull()
    expect(dynamicSupply.toString()).toBe(minted.toString())
  })

  it('accepts a threshold equal to the quote cap and throws one lamport above it', () => {
    expect(() => buildZeroPvpConfigParameters(presetOf({ migrationQuoteThreshold: SOL.maxMigrationQuoteThreshold }))).not.toThrow()
    expect(() => buildZeroPvpConfigParameters(presetOf({ migrationQuoteThreshold: 10_000_000_001n })))
      .toThrow(/migrationQuoteThreshold 10000000001 exceeds the SOL cap 10000000000/)
  })

  it('builds xStock presets in the quote decimals', () => {
    const params = buildZeroPvpConfigParameters(presetOf({ quote: TSLAX, migrationQuoteThreshold: 300_000_000n }))

    expect(params.migrationQuoteThreshold.toString()).toBe('300000000')
    expect(() => buildZeroPvpConfigParameters(presetOf({ quote: TSLAX, migrationQuoteThreshold: 500_000_001n }))).toThrow(/cap/)
  })

  it.each([
    ['feeBps below the DBC minimum', { feeBps: 24 }, /feeBps/],
    ['feeBps above the DBC maximum', { feeBps: 9_901 }, /feeBps/],
    ['fractional feeBps', { feeBps: 100.5 }, /feeBps/],
    ['zero threshold', { migrationQuoteThreshold: 0n }, /migrationQuoteThreshold/],
    ['non-bigint threshold', { migrationQuoteThreshold: 1_000 as unknown as bigint }, /migrationQuoteThreshold/],
    ['zero supply', { totalTokenSupply: 0n }, /totalTokenSupply/],
    ['supply not in whole tokens', { totalTokenSupply: ONE_BILLION_TOKENS + 1n }, /totalTokenSupply/],
    ['0% on migration', { percentageSupplyOnMigration: 0 }, /percentageSupplyOnMigration/],
    ['100% on migration', { percentageSupplyOnMigration: 100 }, /percentageSupplyOnMigration/],
    ['missing quote', { quote: undefined as unknown as QuoteMintInfo }, /quote/],
  ])('rejects %s', (_label, overrides, message) => {
    expect(() => buildZeroPvpConfigParameters(presetOf(overrides as Partial<PresetOptions>))).toThrow(message)
  })

  it('returns a fresh object per call', () => {
    const opts = presetOf()
    expect(buildZeroPvpConfigParameters(opts)).not.toBe(buildZeroPvpConfigParameters(opts))
  })
})

describe('buildLaunchPlan (offline)', () => {
  it('builds config, pool and market transactions with their extra signers', async () => {
    const params = launchParams()
    const plan = await buildLaunchPlan(params)

    expect(plan.transactions).toHaveLength(3)
    expect(plan.signers).toHaveLength(3)
    expect(signerKeys(plan, 0)).toEqual([plan.config.toBase58()])
    expect(signerKeys(plan, 1)).toEqual([plan.baseMint.toBase58()])
    expect(signerKeys(plan, 2)).toEqual([])
    expect(plan.pool.toBase58()).toBe(deriveDbcPoolAddress(SOL.mint, plan.baseMint, plan.config).toBase58())
    expect(plan.market.toBase58()).toBe(findMarketPda(plan.pool, localnet.routerProgramId).toBase58())

    const [createConfig, createPool, openMarket] = plan.transactions.map((tx) => tx.instructions)
    const dbc = DYNAMIC_BONDING_CURVE_PROGRAM_ID.toBase58()
    expect(keys(createConfig!)).toEqual([dbc])
    expect(keys(createPool!)).toEqual([dbc])
    expect(keys(openMarket!)).toEqual([localnet.hookProgramId.toBase58(), localnet.routerProgramId.toBase58()])
    expect(openMarket![0]!.keys[1]!.pubkey.toBase58()).toBe(findExtraAccountMetasPda(plan.baseMint, localnet.hookProgramId).toBase58())
    expect(openMarket![1]!.keys[5]!.pubkey.toBase58()).toBe(findBufferPda(plan.market, localnet.routerProgramId).toBase58())
  })

  it('passes the caller wallets as fee claimer and leftover receiver', async () => {
    const preset = presetOf()
    const plan = await buildLaunchPlan(launchParams({ preset }))
    const configKeys = plan.transactions[0]!.instructions[0]!.keys.map((k) => k.pubkey.toBase58())

    expect(configKeys).toContain(preset.feeClaimer.toBase58())
    expect(configKeys).toContain(preset.leftoverReceiver.toBase58())
  })

  it('sets the creator as fee payer and the recent blockhash on every transaction', async () => {
    const params = launchParams()
    const { blockhash } = await params.connection.getLatestBlockhash()
    const plan = await buildLaunchPlan(params)

    plan.transactions.forEach((tx) => {
      expect(tx.feePayer?.toBase58()).toBe(params.creator.toBase58())
      expect(tx.recentBlockhash).toBe(blockhash)
    })
  })

  it('appends the router buy to the market transaction when initialBuy > 0', async () => {
    const creator = Keypair.generate().publicKey
    const noBuy = await buildLaunchPlan(launchParams({ creator, initialBuy: 0n }))
    const withBuy = await buildLaunchPlan(launchParams({ creator, initialBuy: INITIAL_BUY }))
    const marketTx = withBuy.transactions[2]!.instructions
    const buy = marketTx[marketTx.length - 1]!

    expect(noBuy.transactions[2]!.instructions).toHaveLength(2)
    expect(marketTx.length).toBeGreaterThan(2)
    expect(buy.programId.toBase58()).toBe(localnet.routerProgramId.toBase58())
    expect(buy.keys[2]!.pubkey.toBase58()).toBe(findPositionPda(withBuy.market, creator, localnet.routerProgramId).toBase58())
  })

  it('keeps every transaction within 1232 bytes at the metadata limits, with an initial buy and an xStock quote', async () => {
    const plans = await Promise.all([
      buildLaunchPlan(launchParams({ name: 'N'.repeat(32), symbol: 'S'.repeat(10), uri: 'u'.repeat(200), initialBuy: INITIAL_BUY })),
      buildLaunchPlan(launchParams({
        cluster: mainnet, name: 'N'.repeat(32), symbol: 'S'.repeat(10), uri: 'u'.repeat(200), initialBuy: 1n,
        preset: presetOf({ quote: TSLAX, migrationQuoteThreshold: 500_000_000n }),
      })),
    ])

    plans.flatMap((plan) => plan.transactions).forEach((tx) => expect(wireSize(tx)).toBeLessThanOrEqual(PACKET_DATA_SIZE))
  })

  it('passes the xStock token badge to DBC', async () => {
    const plan = await buildLaunchPlan(launchParams({ cluster: mainnet, preset: presetOf({ quote: TSLAX, migrationQuoteThreshold: 1n }) }))
    const badge = TSLAX.tokenBadge!.toBase58()

    plan.transactions.slice(0, 2).forEach((tx) => expect(tx.instructions[0]!.keys.map((k) => k.pubkey.toBase58())).toContain(badge))
  })

  it('throws on a uri longer than 200 characters', async () => {
    await expect(buildLaunchPlan(launchParams({ uri: 'u'.repeat(201) }))).rejects.toThrow(/uri must be at most 200 bytes/)
  })

  it('throws when the threshold exceeds the quote cap', async () => {
    await expect(buildLaunchPlan(launchParams({ preset: presetOf({ migrationQuoteThreshold: 10_000_000_001n }) })))
      .rejects.toThrow(/exceeds the SOL cap/)
  })

  it.each([
    ['an empty name', { name: '' }, /name/],
    ['a name above 32 bytes', { name: 'N'.repeat(33) }, /name/],
    ['an empty symbol', { symbol: '' }, /symbol/],
    ['a symbol above 10 bytes', { symbol: 'S'.repeat(11) }, /symbol/],
    ['a negative initial buy', { initialBuy: -1n }, /initialBuy/],
    ['a non-key creator', { creator: 'creator' as unknown as PublicKey }, /creator/],
    ['a quote the cluster does not allow', { cluster: getClusterConfig('devnet'), preset: presetOf({ quote: TSLAX, migrationQuoteThreshold: 1n }) }, /quote mint/],
  ])('rejects %s', async (_label, overrides, message) => {
    await expect(buildLaunchPlan(launchParams(overrides as Partial<LaunchParams>))).rejects.toThrow(message)
  })

  it('rejects an off-curve (PDA) fee claimer or leftover receiver', async () => {
    const pda = findMarketPda(Keypair.generate().publicKey)
    await expect(buildLaunchPlan(launchParams({ preset: presetOf({ feeClaimer: pda }) }))).rejects.toThrow(/feeClaimer/)
    await expect(buildLaunchPlan(launchParams({ preset: presetOf({ leftoverReceiver: pda }) }))).rejects.toThrow(/leftoverReceiver/)
  })

  it('wraps a blockhash failure with context', async () => {
    const connection = new FixedBlockhashConnection(() => {
      throw new Error('rpc down')
    })
    await expect(buildLaunchPlan(launchParams({ connection }))).rejects.toThrow(/recent blockhash.*rpc down/)
  })
})

describe('buildLaunchPlan on LiteSVM (wSOL, capped router)', () => {
  let svm: LiteSVM

  beforeAll(async () => {
    // Reuse the SDK-02 setup for a LiteSVM with DBC, zpvp_hook and the capped router loaded.
    ;({ svm } = await setupMarket({ traders: 0 }))
  })

  /** Signs each transaction with the creator and its extra signers and sends it; throws on the first failure. */
  function execute(plan: LaunchPlan, creator: Keypair): void {
    plan.transactions.forEach((tx, i) => {
      tx.sign(creator, ...(plan.signers[i] ?? []))
      expect(tx.serialize().length).toBeLessThanOrEqual(PACKET_DATA_SIZE)
      const res = svm.sendTransaction(tx)
      if (res instanceof FailedTransactionMetadata) {
        throw new Error(`launch tx ${i} failed: ${res.err().toString()}\n${res.meta().logs().slice(-8).join('\n')}`)
      }
    })
  }

  async function launch(initialBuy?: bigint): Promise<{ plan: LaunchPlan; creator: Keypair }> {
    const creator = Keypair.generate()
    svm.airdrop(creator.publicKey, CREATOR_LAMPORTS)
    const connection = new FixedBlockhashConnection(() => svm.latestBlockhash())
    const plan = await buildLaunchPlan(launchParams({ connection, cluster: localnet, creator: creator.publicKey, initialBuy }))
    execute(plan, creator)
    return { plan, creator }
  }

  const accountData = (address: PublicKey): Buffer => {
    const account = svm.getAccount(address)
    if (account === null) throw new Error(`account ${address.toBase58()} does not exist`)
    return Buffer.from(account.data)
  }

  it('creates the config, the pool and a market the capped router accepts', async () => {
    const { plan } = await launch()

    expect(svm.getAccount(plan.config)?.owner.toBase58()).toBe(localnet.dbcProgramId.toBase58())
    expect(readU64(svm, plan.config, CONFIG_MIGRATION_QUOTE_THRESHOLD_OFFSET)).toBe(SCENARIO_THRESHOLD)
    expect(isCurveComplete(svm, plan.pool)).toBe(false)
    expect(svm.getAccount(findExtraAccountMetasPda(plan.baseMint, localnet.hookProgramId))).not.toBeNull()

    const market = decodeMarket(plan.market, accountData(plan.market))
    expect(market.pool.toBase58()).toBe(plan.pool.toBase58())
    expect(market.config.toBase58()).toBe(plan.config.toBase58())
    expect(market.baseMint.toBase58()).toBe(plan.baseMint.toBase58())
    expect(market.quoteMint.toBase58()).toBe(NATIVE_MINT.toBase58())
    expect(market.feeNumerator).toBe(BigInt(FEE_BPS) * 100_000n)
    expect(market.totalBasis).toBe(0n)
  })

  it('records the creator position for an initial buy', async () => {
    const { plan, creator } = await launch(INITIAL_BUY)
    const positionAddress = findPositionPda(plan.market, creator.publicKey, localnet.routerProgramId)
    const position = decodePosition(positionAddress, accountData(positionAddress))
    const market = decodeMarket(plan.market, accountData(plan.market))

    expect(position.owner.toBase58()).toBe(creator.publicKey.toBase58())
    expect(position.tokens).toBeGreaterThan(0n)
    expect(position.basis).toBeGreaterThan(0n)
    expect(market.totalBasis).toBe(position.basis)
  })
})
