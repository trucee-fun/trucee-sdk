/**
 * Shared LiteSVM setup for SDK tests: loads DBC, the Zero-PvP hook and the capped router, creates a DBC
 * transfer-hook config + pool (wSOL quote, litesvm-diff/out/scenario_tiny.json) through the DBC SDK, initialises
 * the hook's extra-account-metas and the router market with the SDK builders, and funds N traders with SOL.
 * Programs: run `cd zpvp && cargo build-sbf` first.
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import BN from 'bn.js'
import { Connection, Keypair, PublicKey, Transaction, type TransactionInstruction } from '@solana/web3.js'
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import {
  createDbcProgram,
  deriveDbcEventAuthority,
  deriveDbcPoolAddress,
  deriveDbcPoolAuthority,
  deriveDbcTokenVaultAddress,
  type ConfigParameters,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import { FailedTransactionMetadata, LiteSVM } from 'litesvm'
import { getClusterConfig } from '../../src/constants.js'
import { initExtraAccountMetasInstruction, initMarketInstruction } from '../../src/instructions.js'
import { findBufferPda, findMarketPda } from '../../src/pda.js'
import type { ClusterConfig, MarketAccounts } from '../../src/types.js'

const REPO_ROOT = new URL('../../../', import.meta.url)
const repoPath = (relative: string): string => fileURLToPath(new URL(relative, REPO_ROOT))

const PROGRAM_PATHS = Object.freeze({
  dbc: repoPath('litesvm-diff/programs/dbc.so'),
  hook: repoPath('zpvp/target/deploy/zpvp_hook.so'),
  router: repoPath('zpvp/target/deploy/zpvp_router.so'),
})
const SCENARIO_PATH = repoPath('litesvm-diff/out/scenario_tiny.json')

/** DBC pool: MigrationProgress byte (0 = PreBondingCurve). */
export const POOL_MIGRATION_PROGRESS_OFFSET = 308
/** DBC ConfigWithTransferHook: swap_base_amount and migration_quote_threshold (u64). */
export const CONFIG_SWAP_BASE_AMOUNT_OFFSET = 256
export const CONFIG_MIGRATION_QUOTE_THRESHOLD_OFFSET = 264
/** SPL token account amount (u64). */
const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64

const BASE_DECIMALS = 6
const ADMIN_LAMPORTS = 1_000_000_000_000n // 1000 SOL
const TRADER_LAMPORTS = 100_000_000_000n // 100 SOL
const SVM_LAMPORTS = 10n ** 18n

export type SendResult =
  | { readonly ok: true; readonly logs: readonly string[] }
  | { readonly ok: false; readonly error: string; readonly logs: readonly string[] }

export type Send = (payer: Keypair, ixs: readonly TransactionInstruction[], signers?: readonly Keypair[]) => SendResult

export interface MarketSetup {
  readonly svm: LiteSVM
  readonly cluster: ClusterConfig
  readonly accounts: MarketAccounts
  readonly traders: Keypair[]
  /** Pool creator, fee claimer and payer of the setup transactions. */
  readonly admin: Keypair
  readonly send: Send
}

interface Scenario {
  readonly sqrt_start_price: string
  readonly fee_numerator: number
  readonly migration_quote_threshold: string
  readonly curve: readonly { readonly sqrt_price: string; readonly liquidity: string }[]
}

function loadScenario(path: string): Scenario {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  const scenario = (Array.isArray(parsed) ? parsed[0] : null) as Partial<Scenario> | null
  const valid = !!scenario && typeof scenario.sqrt_start_price === 'string' &&
    Number.isSafeInteger(scenario.fee_numerator) && typeof scenario.migration_quote_threshold === 'string' &&
    Array.isArray(scenario.curve) && scenario.curve.length > 0
  if (!valid) throw new Error(`${path}: expected [{ sqrt_start_price, fee_numerator, migration_quote_threshold, curve }]`)
  return scenario as Scenario
}

const ZERO_VESTING = { vestingPercentage: 0, bpsPerPeriod: 0, numberOfPeriods: 0, cliffDurationFromMigrationTime: 0, frequency: 0 }

/** Static-fee, quote-collected DBC config (the only kind the router accepts), mirrored from litesvm-diff. */
function configParameters(s: Scenario): ConfigParameters {
  return {
    poolFees: {
      baseFee: { cliffFeeNumerator: new BN(s.fee_numerator), firstFactor: 0, secondFactor: new BN(0), thirdFactor: new BN(0), baseFeeMode: 0 },
      dynamicFee: null,
    },
    collectFeeMode: 0, migrationOption: 1, activationType: 0, tokenType: 1, tokenDecimal: BASE_DECIMALS,
    partnerLiquidityPercentage: 0, partnerPermanentLockedLiquidityPercentage: 100,
    creatorLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 0,
    migrationQuoteThreshold: new BN(s.migration_quote_threshold), sqrtStartPrice: new BN(s.sqrt_start_price),
    lockedVesting: { amountPerPeriod: new BN(0), cliffDurationFromMigrationTime: new BN(0), frequency: new BN(0), numberOfPeriod: new BN(0), cliffUnlockAmount: new BN(0) },
    migrationFeeOption: 0, tokenSupply: null, creatorTradingFeePercentage: 0, tokenUpdateAuthority: 1,
    migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
    migratedPoolFee: { collectFeeMode: 0, dynamicFee: 0, poolFeeBps: 0 },
    poolCreationFee: new BN(0), partnerLiquidityVestingInfo: ZERO_VESTING, creatorLiquidityVestingInfo: ZERO_VESTING,
    migratedPoolBaseFeeMode: 0,
    migratedPoolMarketCapFeeSchedulerParams: { numberOfPeriod: 0, sqrtPriceStepBps: 0, schedulerExpirationDuration: 0, reductionFactor: new BN(0) },
    enableFirstSwapWithMinFee: false, compoundingFeeBps: 0, padding: [0, 0],
    curve: s.curve.map((p) => ({ sqrtPrice: new BN(p.sqrt_price), liquidity: new BN(p.liquidity) })),
  }
}

function createSvm(): LiteSVM {
  const missing = Object.values(PROGRAM_PATHS).filter((path) => !existsSync(path))
  if (missing.length > 0) throw new Error(`missing program binaries (run \`cd zpvp && cargo build-sbf\`): ${missing.join(', ')}`)
  const cluster = getClusterConfig('localnet')
  const svm = new LiteSVM().withLamports(SVM_LAMPORTS).withNativeMints()
  svm.addProgramFromFile(cluster.dbcProgramId, PROGRAM_PATHS.dbc)
  svm.addProgramFromFile(cluster.hookProgramId, PROGRAM_PATHS.hook)
  svm.addProgramFromFile(cluster.routerProgramId, PROGRAM_PATHS.router)
  return svm
}

function createSend(svm: LiteSVM): Send {
  return (payer, ixs, signers = []) => {
    const tx = new Transaction().add(...ixs)
    tx.recentBlockhash = svm.latestBlockhash()
    tx.feePayer = payer.publicKey
    tx.sign(payer, ...signers)
    const res = svm.sendTransaction(tx)
    svm.expireBlockhash()
    if (res instanceof FailedTransactionMetadata) {
      return { ok: false, error: res.err().toString(), logs: res.meta().logs() }
    }
    return { ok: true, logs: res.logs() }
  }
}

const mustSend = (send: Send, step: string, payer: Keypair, ixs: readonly TransactionInstruction[], signers: readonly Keypair[] = []): void => {
  const res = send(payer, ixs, signers)
  if (!res.ok) throw new Error(`setupMarket: ${step} failed: ${res.error}\n${res.logs.slice(-5).join('\n')}`)
}

/** Raw little-endian u64 at `offset` of an account; throws when the account is missing or too short. */
export function readU64(svm: LiteSVM, address: PublicKey, offset: number): bigint {
  const account = svm.getAccount(address)
  if (account === null || account.data.length < offset + 8) throw new Error(`account ${address.toBase58()} missing or shorter than ${offset + 8} bytes`)
  return new DataView(account.data.buffer, account.data.byteOffset, account.data.byteLength).getBigUint64(offset, true)
}

/** Token account balance; 0 when the account does not exist (e.g. a closed wSOL ATA). */
export function tokenAmount(svm: LiteSVM, tokenAccount: PublicKey): bigint {
  return svm.getAccount(tokenAccount) === null ? 0n : readU64(svm, tokenAccount, TOKEN_ACCOUNT_AMOUNT_OFFSET)
}

export function isCurveComplete(svm: LiteSVM, pool: PublicKey): boolean {
  const account = svm.getAccount(pool)
  if (account === null) throw new Error(`pool ${pool.toBase58()} does not exist`)
  return account.data[POOL_MIGRATION_PROGRESS_OFFSET] !== 0
}

/** One wSOL market on a fresh LiteSVM, plus `traders` funded keypairs (no token accounts yet). */
export async function setupMarket(opts: { traders: number }): Promise<MarketSetup> {
  if (!Number.isSafeInteger(opts.traders) || opts.traders < 0) throw new RangeError(`traders must be a non-negative integer, got ${opts.traders}`)
  const scenario = loadScenario(SCENARIO_PATH)
  const svm = createSvm()
  const send = createSend(svm)
  const cluster = getClusterConfig('localnet')
  const { program: dbc } = createDbcProgram(new Connection('http://127.0.0.1:1'))
  const eventAuthority = deriveDbcEventAuthority()
  const admin = Keypair.generate()
  svm.airdrop(admin.publicKey, ADMIN_LAMPORTS)

  const config = Keypair.generate()
  const createConfigIx = await dbc.methods.createConfigWithTransferHook(configParameters(scenario))
    .accountsPartial({ config: config.publicKey, feeClaimer: admin.publicKey, leftoverReceiver: admin.publicKey,
      quoteMint: NATIVE_MINT, transferHookProgram: cluster.hookProgramId, payer: admin.publicKey, eventAuthority })
    .instruction()
  mustSend(send, 'create_config_with_transfer_hook', admin, [createConfigIx], [config])

  const baseMint = Keypair.generate()
  const pool = deriveDbcPoolAddress(NATIVE_MINT, baseMint.publicKey, config.publicKey)
  const baseVault = deriveDbcTokenVaultAddress(pool, baseMint.publicKey)
  const quoteVault = deriveDbcTokenVaultAddress(pool, NATIVE_MINT)
  const createPoolIx = await dbc.methods.initializeVirtualPoolWithToken2022TransferHook({ name: 'Trucee', symbol: 'TRC', uri: 'https://trucee.test' })
    .accountsPartial({ config: config.publicKey, poolAuthority: deriveDbcPoolAuthority(), creator: admin.publicKey,
      baseMint: baseMint.publicKey, quoteMint: NATIVE_MINT, pool, baseVault, quoteVault, transferHookProgram: cluster.hookProgramId,
      payer: admin.publicKey, tokenQuoteProgram: TOKEN_PROGRAM_ID, tokenProgram: TOKEN_2022_PROGRAM_ID, eventAuthority })
    .instruction()
  mustSend(send, 'initialize_virtual_pool_with_token2022_transfer_hook', admin, [createPoolIx], [baseMint])

  mustSend(send, 'hook initialize_extra_account_meta_list', admin,
    [initExtraAccountMetasInstruction(admin.publicKey, baseMint.publicKey, cluster.hookProgramId)])
  mustSend(send, 'router init_market', admin, [initMarketInstruction({
    cluster, payer: admin.publicKey, pool, config: config.publicKey, quoteMint: NATIVE_MINT, quoteTokenProgram: TOKEN_PROGRAM_ID,
  })])

  const market = findMarketPda(pool, cluster.routerProgramId)
  const accounts: MarketAccounts = Object.freeze({
    market, pool, config: config.publicKey, baseMint: baseMint.publicKey, quoteMint: NATIVE_MINT, baseVault, quoteVault,
    bufferVault: findBufferPda(market, cluster.routerProgramId), quoteTokenProgram: TOKEN_PROGRAM_ID,
  })
  const traders = Array.from({ length: opts.traders }, () => Keypair.generate())
  traders.forEach((trader) => svm.airdrop(trader.publicKey, TRADER_LAMPORTS))
  return { svm, cluster, accounts, traders, admin, send }
}
