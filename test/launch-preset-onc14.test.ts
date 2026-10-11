/**
 * SDK-23: every SDK-built launch passes the hardened init_market (ONC-14). DBC's buildCurve always returns a fixed
 * supply (tokenSupply { pre, post }), which DBC stores as fixed_token_supply_flag = 1 and the router rejects with
 * PresetNotAllowed (6023). The SDK preset is dynamic supply instead (tokenSupply null; DBC burns the leftover at
 * migration), as docs/trucee-plan.md locks it. Runs on LiteSVM with DBC, zpvp_hook and the ONC-14 capped router
 * from zpvp/target/deploy (wSOL quote, threshold from litesvm-diff/out/scenario_tiny.json). The SDK also fails closed:
 * a buildCurve result that breaks any preset rule (mutated through a pass-through mock) never becomes a config.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Buffer } from 'buffer'
import BN from 'bn.js'
import {
  Connection,
  Keypair,
  Transaction,
  type BlockhashWithExpiryBlockHeight,
  type PublicKey,
  type TransactionInstruction,
} from '@solana/web3.js'
import {
  createDbcProgram,
  deriveDbcEventAuthority,
  getDynamicFeeParams,
  type ConfigParameters,
  type ConfigWithTransferHook,
  type PoolConfig,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import { FailedTransactionMetadata, type LiteSVM } from 'litesvm'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildLaunchPlan, buildZeroPvpConfigParameters, decodeMarket, getClusterConfig } from '../src/index.js'
import type { LaunchParams, LaunchPlan, PresetOptions, QuoteMintInfo } from '../src/index.js'
import { CONFIG_SWAP_BASE_AMOUNT_OFFSET, readU64, setupMarket } from './helpers/litesvm.js'

type CurveMutation = (params: ConfigParameters) => ConfigParameters

/** Applied to every buildCurve result while set; buildCurve is the real one otherwise. Reset after each test. */
const curveMutation = vi.hoisted(() => ({ apply: undefined as CurveMutation | undefined }))

vi.mock('@meteora-ag/dynamic-bonding-curve-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@meteora-ag/dynamic-bonding-curve-sdk')>()
  return {
    ...actual,
    buildCurve: (...args: Parameters<typeof actual.buildCurve>): ConfigParameters => {
      const built = actual.buildCurve(...args)
      return curveMutation.apply === undefined ? built : curveMutation.apply(built)
    },
  }
})

const FEE_BPS = 100
const CREATOR_LAMPORTS = 10_000_000_000n // 10 SOL
const BASE_DECIMALS = 6
/** The preset's default totalTokenSupply: 1_000_000_000 tokens in raw base units. */
const DEFAULT_TOTAL_SUPPLY = 1_000_000_000n * 10n ** BigInt(BASE_DECIMALS)
const PRESET_NOT_ALLOWED = 6023
const CONFIG_WITH_TRANSFER_HOOK_LEN = 1128
/** Token-2022 mint: supply (u64) follows the 4-byte COption tag and the 32-byte mint authority. */
const MINT_SUPPLY_OFFSET = 36
/** The open-market transaction is [hook extra-metas init, router init_market]. */
const OPEN_MARKET_TX = 2
const INIT_MARKET_IX = 1

const SCENARIO_PATH = fileURLToPath(new URL('../../litesvm-diff/out/scenario_tiny.json', import.meta.url))
const SCENARIO_THRESHOLD = BigInt((JSON.parse(readFileSync(SCENARIO_PATH, 'utf8')) as [{ migration_quote_threshold: string }])[0]
  .migration_quote_threshold)

const localnet = getClusterConfig('localnet')
const SOL: QuoteMintInfo = (() => {
  const quote = localnet.quoteMints.find((q) => q.symbol === 'SOL')
  if (quote === undefined) throw new Error('localnet has no SOL quote')
  return quote
})()

/**
 * DBC ConfigWithTransferHook bytes the router's preset check reads: ONC-14 (LP split, supply flag, locked vesting) and
 * ONC-08/ONC-20 (migration option, migration fees, immutable token authority; not yet checked by this router build),
 * plus the LP vesting percentages that a permanently locked sum of 100 leaves at 0. `idl` reads the same field from
 * the DBC IDL decode.
 */
const PRESET_FIELDS = {
  migrationOption: { offset: 233, size: 1, expected: 1n, idl: (c: PoolConfig) => c.migrationOption },
  partnerPermanentLockedLp: { offset: 239, size: 1, expected: 100n, idl: (c: PoolConfig) => c.partnerPermanentLockedLiquidityPercentage },
  partnerLp: { offset: 240, size: 1, expected: 0n, idl: (c: PoolConfig) => c.partnerLiquidityPercentage },
  creatorPermanentLockedLp: { offset: 241, size: 1, expected: 0n, idl: (c: PoolConfig) => c.creatorPermanentLockedLiquidityPercentage },
  creatorLp: { offset: 242, size: 1, expected: 0n, idl: (c: PoolConfig) => c.creatorLiquidityPercentage },
  fixedTokenSupplyFlag: { offset: 244, size: 1, expected: 0n, idl: (c: PoolConfig) => c.fixedTokenSupplyFlag },
  tokenUpdateAuthority: { offset: 246, size: 1, expected: 1n, idl: (c: PoolConfig) => c.tokenUpdateAuthority },
  migrationFeePercentage: { offset: 247, size: 1, expected: 0n, idl: (c: PoolConfig) => c.migrationFeePercentage },
  creatorMigrationFeePercentage: { offset: 248, size: 1, expected: 0n, idl: (c: PoolConfig) => c.creatorMigrationFeePercentage },
  lockedVestingAmountPerPeriod: { offset: 296, size: 8, expected: 0n, idl: (c: PoolConfig) => c.lockedVestingConfig.amountPerPeriod },
  lockedVestingCliffUnlockAmount: { offset: 328, size: 8, expected: 0n, idl: (c: PoolConfig) => c.lockedVestingConfig.cliffUnlockAmount },
  partnerLpVestingPercentage: { offset: 185, size: 1, expected: 0n, idl: (c: PoolConfig) => c.partnerLiquidityVestingInfo.vestingPercentage },
  creatorLpVestingPercentage: { offset: 201, size: 1, expected: 0n, idl: (c: PoolConfig) => c.creatorLiquidityVestingInfo.vestingPercentage },
} as const
type PresetField = keyof typeof PRESET_FIELDS
type PresetValues = Readonly<Record<PresetField, bigint>>
const FIELD_NAMES = Object.keys(PRESET_FIELDS) as PresetField[]
const valuesOf = (read: (field: PresetField) => bigint): PresetValues =>
  Object.freeze(Object.fromEntries(FIELD_NAMES.map((field) => [field, read(field)])) as Record<PresetField, bigint>)
const EXPECTED_PRESET = valuesOf((field) => PRESET_FIELDS[field].expected)

const { program: dbc } = createDbcProgram(new Connection('http://127.0.0.1:1'))

const NO_LP_VESTING = { vestingPercentage: 0, bpsPerPeriod: 0, numberOfPeriods: 0, cliffDurationFromMigrationTime: 0, frequency: 0 }
/** Half the LP vests over 10 minutes after migration. */
const HALF_LP_VESTING = { vestingPercentage: 50, bpsPerPeriod: 1_000, numberOfPeriods: 10, cliffDurationFromMigrationTime: 0, frequency: 60 }
const ONE = (): BN => new BN(1)
const withLockedVesting = (field: keyof ConfigParameters['lockedVesting']): CurveMutation =>
  (p) => ({ ...p, lockedVesting: { ...p.lockedVesting, [field]: ONE() } })
const withBaseFee = (baseFee: Partial<ConfigParameters['poolFees']['baseFee']>): CurveMutation =>
  (p) => ({ ...p, poolFees: { ...p.poolFees, baseFee: { ...p.poolFees.baseFee, ...baseFee } } })

/** Configs that each break one preset rule; the error must name that rule. */
const PRESET_BREAKERS: readonly (readonly [label: string, mutate: CurveMutation, rule: RegExp])[] = [
  ['locked vesting amountPerPeriod > 0', withLockedVesting('amountPerPeriod'), /no locked vesting/],
  ['locked vesting cliffUnlockAmount > 0', withLockedVesting('cliffUnlockAmount'), /no locked vesting/],
  ['locked vesting numberOfPeriod > 0', withLockedVesting('numberOfPeriod'), /no locked vesting/],
  ['locked vesting frequency > 0', withLockedVesting('frequency'), /no locked vesting/],
  ['locked vesting cliffDurationFromMigrationTime > 0', withLockedVesting('cliffDurationFromMigrationTime'), /no locked vesting/],
  ['a missing lockedVesting', (p) => ({ ...p, lockedVesting: undefined as unknown as ConfigParameters['lockedVesting'] }), /no locked vesting/],
  ['unlocked partner LP', (p) => ({ ...p, partnerPermanentLockedLiquidityPercentage: 93, partnerLiquidityPercentage: 7 }), /no unlocked partner LP/],
  ['unlocked creator LP', (p) => ({ ...p, partnerPermanentLockedLiquidityPercentage: 87, creatorLiquidityPercentage: 13 }), /no unlocked creator LP/],
  ['permanently locked LP summing to 90', (p) => ({ ...p, partnerPermanentLockedLiquidityPercentage: 90 }), /permanently locked LP summing to 100/],
  ['partner LP vesting', (p) => ({ ...p, partnerPermanentLockedLiquidityPercentage: 50, partnerLiquidityVestingInfo: HALF_LP_VESTING }),
    /no partner LP vesting/],
  ['creator LP vesting', (p) => ({ ...p, partnerPermanentLockedLiquidityPercentage: 50, creatorLiquidityVestingInfo: HALF_LP_VESTING }),
    /no creator LP vesting/],
  ['an LP vesting frequency with a 0 percentage', (p) => ({ ...p, partnerLiquidityVestingInfo: { ...NO_LP_VESTING, frequency: 60 } }),
    /no partner LP vesting/],
  ['a migration fee', (p) => ({ ...p, migrationFee: { feePercentage: 5, creatorFeePercentage: 0 } }), /no migration fee/],
  ['a creator migration fee', (p) => ({ ...p, migrationFee: { feePercentage: 0, creatorFeePercentage: 50 } }), /no migration fee/],
  ['DAMM v1 migration', (p) => ({ ...p, migrationOption: 0 }), /DAMM v2 migration/],
  ['a creator mint authority (tokenUpdateAuthority 3)', (p) => ({ ...p, tokenUpdateAuthority: 3 }), /an immutable base mint/],
  ['a partner mint authority (tokenUpdateAuthority 4)', (p) => ({ ...p, tokenUpdateAuthority: 4 }), /an immutable base mint/],
  ['a creator update authority (tokenUpdateAuthority 0)', (p) => ({ ...p, tokenUpdateAuthority: 0 }), /an immutable base mint/],
  ['fee scheduler periods', withBaseFee({ firstFactor: 10 }), /a static quote-collected fee/],
  ['a rate-limiter base fee', withBaseFee({ baseFeeMode: 2 }), /a static quote-collected fee/],
  ['a dynamic fee', (p) => ({ ...p, poolFees: { ...p.poolFees, dynamicFee: getDynamicFeeParams(FEE_BPS) } }), /a static quote-collected fee/],
  ['fees collected in both tokens', (p) => ({ ...p, collectFeeMode: 1 }), /a static quote-collected fee/],
]

const presetOf = (overrides: Partial<PresetOptions> = {}): PresetOptions => ({
  quote: SOL,
  migrationQuoteThreshold: SCENARIO_THRESHOLD,
  feeBps: FEE_BPS,
  feeClaimer: Keypair.generate().publicKey,
  leftoverReceiver: Keypair.generate().publicKey,
  ...overrides,
})

/** Real Connection to a dead port that only serves LiteSVM's blockhash; a first build makes no other RPC call. */
class SvmBlockhashConnection extends Connection {
  constructor(private readonly svm: LiteSVM) {
    super('http://127.0.0.1:1')
  }

  override async getLatestBlockhash(): Promise<BlockhashWithExpiryBlockHeight> {
    return { blockhash: this.svm.latestBlockhash(), lastValidBlockHeight: 1_000 }
  }
}

describe('SDK launch preset against the ONC-14 router (LiteSVM, wSOL, capped router)', () => {
  let svm: LiteSVM

  beforeAll(async () => {
    ;({ svm } = await setupMarket({ traders: 0 }))
  })

  const fund = (): Keypair => {
    const keypair = Keypair.generate()
    svm.airdrop(keypair.publicKey, CREATOR_LAMPORTS)
    return keypair
  }

  const planFor = (creator: Keypair, preset: PresetOptions): Promise<LaunchPlan> => {
    const params: LaunchParams = {
      connection: new SvmBlockhashConnection(svm), cluster: localnet, creator: creator.publicKey,
      name: 'Trucee', symbol: 'TRC', uri: 'https://trucee.test/meta.json', preset,
    }
    return buildLaunchPlan(params)
  }

  /** Signs and sends `tx`; returns the error with its logs, or null. */
  const send = (tx: Transaction, signers: readonly Keypair[]): string | null => {
    tx.sign(...signers)
    const res = svm.sendTransaction(tx)
    return res instanceof FailedTransactionMetadata ? `${res.err().toString()}\n${res.meta().logs().join('\n')}` : null
  }

  const sendPlanTx = (plan: LaunchPlan, i: number, creator: Keypair): string | null => {
    const tx = plan.transactions[i]
    if (tx === undefined) throw new Error(`plan has no transaction ${i}`)
    return send(tx, [creator, ...(plan.signers[i] ?? [])])
  }

  const accountData = (address: PublicKey): Buffer => {
    const account = svm.getAccount(address)
    if (account === null) throw new Error(`account ${address.toBase58()} does not exist`)
    return Buffer.from(account.data)
  }

  /** The preset bytes of a config at the router's offsets, checked against the DBC IDL decode of the same account. */
  const presetBytes = (config: PublicKey): PresetValues => {
    const data = accountData(config)
    expect(data.length).toBe(CONFIG_WITH_TRANSFER_HOOK_LEN)
    const raw = valuesOf((field) => {
      const { offset, size } = PRESET_FIELDS[field]
      return size === 1 ? BigInt(data[offset]!) : data.readBigUInt64LE(offset)
    })
    const { config: decoded } = dbc.coder.accounts.decode<ConfigWithTransferHook>('configWithTransferHook', data)
    expect(raw).toEqual(valuesOf((field) => BigInt(PRESET_FIELDS[field].idl(decoded).toString())))
    return raw
  }

  /** The plan's own create-config instruction, with `params` in place of the SDK preset. */
  const createConfigWith = (plan: LaunchPlan, preset: PresetOptions, creator: Keypair, params: ConfigParameters): Promise<TransactionInstruction> =>
    dbc.methods.createConfigWithTransferHook(params)
      .accountsPartial({
        config: plan.config, feeClaimer: preset.feeClaimer, leftoverReceiver: preset.leftoverReceiver, quoteMint: SOL.mint,
        transferHookProgram: localnet.hookProgramId, payer: creator.publicKey, eventAuthority: deriveDbcEventAuthority(),
      })
      .instruction()

  it('opens the market for an SDK-built plan: init_market passes the preset check', async () => {
    const creator = fund()
    const plan = await planFor(creator, presetOf())

    plan.transactions.forEach((_, i) => expect(sendPlanTx(plan, i, creator)).toBeNull())

    const market = decodeMarket(plan.market, accountData(plan.market))
    expect(market.pool.toBase58()).toBe(plan.pool.toBase58())
    expect(market.config.toBase58()).toBe(plan.config.toBase58())
    expect(market.baseMint.toBase58()).toBe(plan.baseMint.toBase58())
  })

  it('creates a dynamic-supply config: fixed_token_supply_flag @244 == 0, LP fully and permanently locked, no vesting, DAMM v2, no migration fee', async () => {
    const creator = fund()
    const plan = await planFor(creator, presetOf())
    expect(sendPlanTx(plan, 0, creator)).toBeNull()

    const bytes = presetBytes(plan.config)

    expect(bytes.fixedTokenSupplyFlag).toBe(0n)
    expect(bytes).toEqual(EXPECTED_PRESET)
    expect(bytes.partnerPermanentLockedLp + bytes.creatorPermanentLockedLp).toBe(100n)
  })

  it('still mints the default 1_000_000_000 tokens for a dynamic-supply pool (swap amount with buffer + migration amount)', async () => {
    const creator = fund()
    const plan = await planFor(creator, presetOf())
    expect(sendPlanTx(plan, 0, creator)).toBeNull()
    expect(sendPlanTx(plan, 1, creator)).toBeNull()

    expect(readU64(svm, plan.baseMint, MINT_SUPPLY_OFFSET)).toBe(DEFAULT_TOTAL_SUPPLY)
  })

  it('rejects a fixed-supply variant of the SDK preset (tokenSupply set) with 6023 PresetNotAllowed', async () => {
    const creator = fund()
    const preset = presetOf()
    const dynamicPlan = await planFor(creator, preset)
    const fixedPlan = await planFor(creator, preset)
    const supply = new BN(DEFAULT_TOTAL_SUPPLY.toString())
    const fixedParams: ConfigParameters = {
      ...buildZeroPvpConfigParameters(preset),
      tokenSupply: { preMigrationTokenSupply: supply, postMigrationTokenSupply: supply },
    }
    const configKeypair = fixedPlan.signers[0]?.[0]
    if (configKeypair === undefined) throw new Error('plan has no config signer')
    const createFixedConfig = new Transaction({ feePayer: creator.publicKey, blockhash: svm.latestBlockhash(), lastValidBlockHeight: 1_000 })
      .add(await createConfigWith(fixedPlan, preset, creator, fixedParams))

    expect(sendPlanTx(dynamicPlan, 0, creator)).toBeNull()
    expect(send(createFixedConfig, [creator, configKeypair])).toBeNull()
    expect(presetBytes(fixedPlan.config)).toEqual({ ...EXPECTED_PRESET, fixedTokenSupplyFlag: 1n })
    // Only the supply flag differs: the curve, and so the Anti-Whale cap basis swap_base_amount, is the same.
    expect(readU64(svm, fixedPlan.config, CONFIG_SWAP_BASE_AMOUNT_OFFSET))
      .toBe(readU64(svm, dynamicPlan.config, CONFIG_SWAP_BASE_AMOUNT_OFFSET))
    expect(sendPlanTx(fixedPlan, 1, creator)).toBeNull()

    const error = sendPlanTx(fixedPlan, OPEN_MARKET_TX, creator)

    expect(error).toMatch(new RegExp(`index: ${INIT_MARKET_IX}, error: InstructionErrorCustom \\{ code: ${PRESET_NOT_ALLOWED} \\}`))
    expect(error).toMatch(/Error Code: PresetNotAllowed\. Error Number: 6023\./)
    expect(svm.getAccount(fixedPlan.market)).toBeNull()
  })
})

describe('buildZeroPvpConfigParameters fails closed on a curve that breaks the preset', () => {
  afterEach(() => {
    curveMutation.apply = undefined
  })

  it('replaces any supply buildCurve returns with dynamic supply', () => {
    // The real buildCurve already returns { pre, post: totalSupply }; a different fixed supply is replaced the same way.
    const supply = new BN(1)
    curveMutation.apply = (p) => ({ ...p, tokenSupply: { preMigrationTokenSupply: supply, postMigrationTokenSupply: supply } })

    expect(buildZeroPvpConfigParameters(presetOf()).tokenSupply).toBeNull()
  })

  it.each(PRESET_BREAKERS)('throws on %s', (_label, mutate, rule) => {
    curveMutation.apply = mutate

    expect(() => buildZeroPvpConfigParameters(presetOf())).toThrow(/the config breaks the Zero-PvP preset; it needs /)
    expect(() => buildZeroPvpConfigParameters(presetOf())).toThrow(rule)
  })

  it('names every broken rule at once', () => {
    curveMutation.apply = (p) => ({ ...p, migrationOption: 0, migrationFee: { feePercentage: 5, creatorFeePercentage: 0 } })

    expect(() => buildZeroPvpConfigParameters(presetOf())).toThrow(/it needs no migration fee, DAMM v2 migration$/)
  })

  it('never builds a launch plan from a curve that breaks the preset', async () => {
    curveMutation.apply = (p) => ({ ...p, partnerPermanentLockedLiquidityPercentage: 93, partnerLiquidityPercentage: 7 })
    const params: LaunchParams = {
      connection: new Connection('http://127.0.0.1:1'), cluster: localnet, creator: Keypair.generate().publicKey,
      name: 'Trucee', symbol: 'TRC', uri: 'https://trucee.test/meta.json', preset: presetOf(),
    }

    await expect(buildLaunchPlan(params)).rejects.toThrow(/breaks the Zero-PvP preset; it needs no unlocked partner LP/)
  })
})
