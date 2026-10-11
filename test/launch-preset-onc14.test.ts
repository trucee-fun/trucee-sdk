/**
 * SDK-23: every SDK-built launch passes the hardened init_market (ONC-14). DBC's buildCurve always returns a fixed
 * supply (tokenSupply { pre, post }), which DBC stores as fixed_token_supply_flag = 1 and the router rejects with
 * PresetNotAllowed (6023). The SDK preset is dynamic supply instead (tokenSupply null; DBC burns the leftover at
 * migration), as docs/trucee-plan.md locks it. Runs on LiteSVM with DBC, zpvp_hook and the ONC-14 capped router
 * from zpvp/target/deploy (wSOL quote, threshold from litesvm-diff/out/scenario_tiny.json).
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
  type ConfigParameters,
  type ConfigWithTransferHook,
  type PoolConfig,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import { FailedTransactionMetadata, type LiteSVM } from 'litesvm'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildLaunchPlan, buildZeroPvpConfigParameters, decodeMarket, getClusterConfig } from '../src/index.js'
import type { LaunchParams, LaunchPlan, PresetOptions, QuoteMintInfo } from '../src/index.js'
import { CONFIG_SWAP_BASE_AMOUNT_OFFSET, readU64, setupMarket } from './helpers/litesvm.js'

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
 * ONC-20 (migration option and migration fees, not yet checked by this router build), plus the LP vesting
 * percentages that a permanently locked sum of 100 leaves at 0. `idl` reads the same field from the DBC IDL decode.
 */
const PRESET_FIELDS = {
  migrationOption: { offset: 233, size: 1, expected: 1n, idl: (c: PoolConfig) => c.migrationOption },
  partnerPermanentLockedLp: { offset: 239, size: 1, expected: 100n, idl: (c: PoolConfig) => c.partnerPermanentLockedLiquidityPercentage },
  partnerLp: { offset: 240, size: 1, expected: 0n, idl: (c: PoolConfig) => c.partnerLiquidityPercentage },
  creatorPermanentLockedLp: { offset: 241, size: 1, expected: 0n, idl: (c: PoolConfig) => c.creatorPermanentLockedLiquidityPercentage },
  creatorLp: { offset: 242, size: 1, expected: 0n, idl: (c: PoolConfig) => c.creatorLiquidityPercentage },
  fixedTokenSupplyFlag: { offset: 244, size: 1, expected: 0n, idl: (c: PoolConfig) => c.fixedTokenSupplyFlag },
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
