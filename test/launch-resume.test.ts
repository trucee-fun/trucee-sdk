/**
 * SDK-22: buildLaunchPlan resumes a partial launch. Given the first plan's config and base-mint keypairs, it fetches
 * the config, pool, hook extra-metas and router market in one call and drops what already exists. A launch then
 * completes even after a third party sends the permissionless hook init and init_market between the creator's
 * transactions. Existing accounts that do not match the caller's launch are an error, not a silent skip.
 */
import { Buffer } from 'buffer'
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  type AccountInfo,
  type BlockhashWithExpiryBlockHeight,
  type TransactionInstruction,
} from '@solana/web3.js'
import { DYNAMIC_BONDING_CURVE_PROGRAM_ID, deriveDbcPoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { FailedTransactionMetadata, type LiteSVM } from 'litesvm'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  buildLaunchPlan,
  decodeMarket,
  decodePosition,
  findExtraAccountMetasPda,
  findMarketPda,
  findPositionPda,
  getClusterConfig,
  initExtraAccountMetasInstruction,
  initMarketInstruction,
} from '../src/index.js'
import type { LaunchParams, LaunchPlan, PresetOptions, QuoteMintInfo } from '../src/index.js'
import { LITESVM_SKIP_REASON, litesvmSuiteTitle, setupMarket } from './helpers/litesvm.js'

const FEE_BPS = 100
const CREATOR_LAMPORTS = 10_000_000_000n // 10 SOL
const INITIAL_BUY = 2_000_000n // 0.002 SOL, far below the Anti-Whale cap
/** Fixed launch input keeps the offline tests independent of sibling fixtures. */
const SCENARIO_THRESHOLD = 303_124_998n

const localnet = getClusterConfig('localnet')
const SOL: QuoteMintInfo = (() => {
  const quote = localnet.quoteMints.find((q) => q.symbol === 'SOL')
  if (quote === undefined) throw new Error('localnet has no SOL quote')
  return quote
})()

const presetOf = (overrides: Partial<PresetOptions> = {}): PresetOptions => ({
  quote: SOL,
  migrationQuoteThreshold: SCENARIO_THRESHOLD,
  feeBps: FEE_BPS,
  feeClaimer: Keypair.generate().publicKey,
  leftoverReceiver: Keypair.generate().publicKey,
  ...overrides,
})

type Accounts = readonly (AccountInfo<Buffer> | null)[]

/** Connection with a fixed blockhash and scripted account reads; records every getMultipleAccountsInfo request. */
class StubConnection extends Connection {
  readonly requests: string[][] = []

  constructor(
    private readonly blockhash: () => string,
    private readonly accounts: (keys: readonly PublicKey[]) => Accounts,
  ) {
    super('http://127.0.0.1:1')
  }

  override async getLatestBlockhash(): Promise<BlockhashWithExpiryBlockHeight> {
    return { blockhash: this.blockhash(), lastValidBlockHeight: 1_000 }
  }

  override async getMultipleAccountsInfo(publicKeys: PublicKey[]): Promise<(AccountInfo<Buffer> | null)[]> {
    this.requests.push(publicKeys.map((key) => key.toBase58()))
    return [...this.accounts(publicKeys)]
  }
}

const offlineConnection = (accounts: (keys: readonly PublicKey[]) => Accounts = (keys) => keys.map(() => null)): StubConnection => {
  const blockhash = Keypair.generate().publicKey.toBase58()
  return new StubConnection(() => blockhash, accounts)
}

const svmConnection = (svm: LiteSVM): StubConnection =>
  new StubConnection(() => svm.latestBlockhash(), (keys) => keys.map((key) => {
    const account = svm.getAccount(key)
    return account === null ? null : { ...account, data: Buffer.from(account.data) }
  }))

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

/** The keypairs FE-18's retry passes back: the first plan's config and base-mint signers. */
const resumeKeys = (plan: LaunchPlan): Pick<LaunchParams, 'configKeypair' | 'baseMintKeypair'> => ({
  configKeypair: plan.signers[0]?.[0],
  baseMintKeypair: plan.signers[1]?.[0],
})

/** Unused keypairs that still take the resume path (both keys present). */
const freshResumeKeys = (): Pick<LaunchParams, 'configKeypair' | 'baseMintKeypair'> => ({
  configKeypair: Keypair.generate(),
  baseMintKeypair: Keypair.generate(),
})

const signerKeys = (plan: LaunchPlan): string[][] => plan.signers.map((keys) => keys.map((k) => k.publicKey.toBase58()))
const programsOf = (plan: LaunchPlan): string[][] => plan.transactions.map((tx) => tx.instructions.map((ix) => ix.programId.toBase58()))
const dataOf = (ix: TransactionInstruction): string => ix.data.toString('base64')

describe('buildLaunchPlan resume (offline)', () => {
  it('makes no account request on a first build with fresh keypairs', async () => {
    const connection = offlineConnection()
    const plan = await buildLaunchPlan(launchParams({ connection }))

    expect(plan.transactions).toHaveLength(3)
    expect(connection.requests).toEqual([])
  })

  it('reuses the given keypairs and fetches config, pool, extra metas, market and creator position in one request', async () => {
    const connection = offlineConnection()
    const configKeypair = Keypair.generate()
    const baseMintKeypair = Keypair.generate()
    const creator = Keypair.generate().publicKey
    const plan = await buildLaunchPlan(launchParams({ connection, creator, configKeypair, baseMintKeypair }))

    expect(plan.config.toBase58()).toBe(configKeypair.publicKey.toBase58())
    expect(plan.baseMint.toBase58()).toBe(baseMintKeypair.publicKey.toBase58())
    expect(plan.pool.toBase58()).toBe(deriveDbcPoolAddress(SOL.mint, plan.baseMint, plan.config).toBase58())
    expect(signerKeys(plan)).toEqual([[plan.config.toBase58()], [plan.baseMint.toBase58()], []])
    expect(connection.requests).toEqual([[
      plan.config.toBase58(),
      plan.pool.toBase58(),
      findExtraAccountMetasPda(plan.baseMint, localnet.hookProgramId).toBase58(),
      plan.market.toBase58(),
      findPositionPda(plan.market, creator, localnet.routerProgramId).toBase58(),
    ]])
  })

  it('treats a lamports-only system account at the market PDA as missing', async () => {
    const prefunded: AccountInfo<Buffer> = { executable: false, owner: SystemProgram.programId, lamports: 1_000_000, data: Buffer.alloc(0) }
    const connection = offlineConnection((keys) => keys.map((_, i) => (i === 3 ? prefunded : null)))
    const plan = await buildLaunchPlan(launchParams({ connection, ...freshResumeKeys() }))

    expect(programsOf(plan)[2]).toEqual([localnet.hookProgramId.toBase58(), localnet.routerProgramId.toBase58()])
  })

  it('throws when an account is owned by an unexpected program', async () => {
    const foreign: AccountInfo<Buffer> = { executable: false, owner: Keypair.generate().publicKey, lamports: 1_000_000, data: Buffer.alloc(8) }
    const connection = offlineConnection((keys) => keys.map((_, i) => (i === 2 ? foreign : null)))

    await expect(buildLaunchPlan(launchParams({ connection, ...freshResumeKeys() })))
      .rejects.toThrow(/hook extra-account-metas \w+ is owned by/)
  })

  it.each([
    ['a configKeypair that is not a Keypair', { configKeypair: Keypair.generate().publicKey as unknown as Keypair }, /configKeypair/],
    ['a baseMintKeypair that is not a Keypair', { baseMintKeypair: 'mint' as unknown as Keypair }, /baseMintKeypair/],
  ])('rejects %s', async (_label, overrides, message) => {
    await expect(buildLaunchPlan(launchParams(overrides as Partial<LaunchParams>))).rejects.toThrow(message)
  })

  it.each([
    ['only configKeypair', { configKeypair: Keypair.generate() }],
    ['only baseMintKeypair', { baseMintKeypair: Keypair.generate() }],
  ])('rejects a half resume with %s', async (_label, overrides) => {
    await expect(buildLaunchPlan(launchParams(overrides))).rejects.toThrow(/configKeypair and baseMintKeypair must be passed together/)
  })

  it('rejects the same keypair for the config and the base mint', async () => {
    const keypair = Keypair.generate()
    await expect(buildLaunchPlan(launchParams({ configKeypair: keypair, baseMintKeypair: keypair }))).rejects.toThrow(/different/)
  })

  it('wraps an account fetch failure with context', async () => {
    const connection = offlineConnection(() => {
      throw new Error('rpc down')
    })
    await expect(buildLaunchPlan(launchParams({ connection, ...freshResumeKeys() })))
      .rejects.toThrow(/could not fetch the launch accounts.*rpc down/)
  })

  it('rejects an account response of the wrong length', async () => {
    const connection = offlineConnection(() => [null])
    await expect(buildLaunchPlan(launchParams({ connection, ...freshResumeKeys() }))).rejects.toThrow(/expected 5 accounts/)
  })
})

describe.skipIf(LITESVM_SKIP_REASON !== null)(litesvmSuiteTitle('buildLaunchPlan resume on LiteSVM (wSOL, capped router)'), () => {
  let svm: LiteSVM

  beforeAll(async () => {
    ;({ svm } = await setupMarket({ traders: 0 }))
  })

  const fund = (): Keypair => {
    const keypair = Keypair.generate()
    svm.airdrop(keypair.publicKey, CREATOR_LAMPORTS)
    return keypair
  }

  /** Signs transaction `i` with the creator and its extra signers and sends it; returns the error, or null. */
  const sendPlanTx = (plan: LaunchPlan, i: number, creator: Keypair): string | null => {
    const tx = plan.transactions[i]
    if (tx === undefined) throw new Error(`plan has no transaction ${i}`)
    tx.sign(creator, ...(plan.signers[i] ?? []))
    const res = svm.sendTransaction(tx)
    return res instanceof FailedTransactionMetadata ? `${res.err().toString()}\n${res.meta().logs().join('\n')}` : null
  }

  const execute = (plan: LaunchPlan, creator: Keypair): void => {
    plan.transactions.forEach((_, i) => expect(sendPlanTx(plan, i, creator)).toBeNull())
  }

  const sendIxs = (payer: Keypair, ixs: readonly TransactionInstruction[]): string | null => {
    const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: svm.latestBlockhash() }).add(...ixs)
    tx.sign(payer)
    const res = svm.sendTransaction(tx)
    return res instanceof FailedTransactionMetadata ? res.err().toString() : null
  }

  const accountData = (address: PublicKey): Buffer => {
    const account = svm.getAccount(address)
    if (account === null) throw new Error(`account ${address.toBase58()} does not exist`)
    return Buffer.from(account.data)
  }

  /** Copies `from` over `to`, as if a matching account had been created there. */
  const plant = (to: PublicKey, from: PublicKey): void => {
    const account = svm.getAccount(from)
    if (account === null) throw new Error(`account ${from.toBase58()} does not exist`)
    svm.setAccount(to, account)
  }

  const frontRunMarket = (plan: LaunchPlan): string | null => {
    const thirdParty = fund()
    return sendIxs(thirdParty, [
      initExtraAccountMetasInstruction(thirdParty.publicKey, plan.baseMint, localnet.hookProgramId),
      initMarketInstruction({
        cluster: localnet, payer: thirdParty.publicKey, pool: plan.pool, config: plan.config, quoteMint: SOL.mint, quoteTokenProgram: SOL.tokenProgram,
      }),
    ])
  }

  it('completes the launch after a third party initialises the hook metas and the market', async () => {
    const creator = fund()
    const connection = svmConnection(svm)
    const params = launchParams({ connection, creator: creator.publicKey, initialBuy: INITIAL_BUY })
    const first = await buildLaunchPlan(params)
    expect(sendPlanTx(first, 0, creator)).toBeNull()
    expect(sendPlanTx(first, 1, creator)).toBeNull()

    expect(frontRunMarket(first)).toBeNull()
    expect(sendPlanTx(first, 2, creator)).toMatch(/already in use/)

    const resumed = await buildLaunchPlan({ ...params, ...resumeKeys(first) })
    const initMarket = initMarketInstruction({
      cluster: localnet, payer: creator.publicKey, pool: first.pool, config: first.config, quoteMint: SOL.mint, quoteTokenProgram: SOL.tokenProgram,
    })

    expect([resumed.config, resumed.pool, resumed.baseMint, resumed.market].map((k) => k.toBase58()))
      .toEqual([first.config, first.pool, first.baseMint, first.market].map((k) => k.toBase58()))
    expect(resumed.transactions).toHaveLength(1)
    expect(signerKeys(resumed)).toEqual([[]])
    expect(programsOf(resumed)[0]).not.toContain(localnet.hookProgramId.toBase58())
    expect(resumed.transactions[0]!.instructions.map(dataOf)).not.toContain(dataOf(initMarket))

    execute(resumed, creator)
    const positionAddress = findPositionPda(first.market, creator.publicKey, localnet.routerProgramId)
    const position = decodePosition(positionAddress, accountData(positionAddress))
    const market = decodeMarket(first.market, accountData(first.market))
    expect(position.owner.toBase58()).toBe(creator.publicKey.toBase58())
    expect(position.tokens).toBeGreaterThan(0n)
    expect(position.basis).toBeGreaterThan(0n)
    expect(market.totalBasis).toBe(position.basis)
  })

  it('returns no transactions when a full launch is rebuilt with initialBuy 0', async () => {
    const creator = fund()
    const params = launchParams({ connection: svmConnection(svm), creator: creator.publicKey })
    const first = await buildLaunchPlan(params)
    execute(first, creator)

    const rebuilt = await buildLaunchPlan({ ...params, ...resumeKeys(first), initialBuy: 0n })

    expect(rebuilt.transactions).toEqual([])
    expect(rebuilt.signers).toEqual([])
    expect(rebuilt.market.toBase58()).toBe(first.market.toBase58())
  })

  it('returns no transactions, so no second buy, when a full launch with an initial buy is rebuilt', async () => {
    const creator = fund()
    const params = launchParams({ connection: svmConnection(svm), creator: creator.publicKey, initialBuy: INITIAL_BUY })
    const first = await buildLaunchPlan(params)
    execute(first, creator)
    const positionAddress = findPositionPda(first.market, creator.publicKey, localnet.routerProgramId)
    const before = decodePosition(positionAddress, accountData(positionAddress))

    const rebuilt = await buildLaunchPlan({ ...params, ...resumeKeys(first) })
    execute(rebuilt, creator)

    expect(rebuilt.transactions).toEqual([])
    expect(rebuilt.signers).toEqual([])
    const after = decodePosition(positionAddress, accountData(positionAddress))
    expect([after.tokens, after.basis]).toEqual([before.tokens, before.basis])
    expect(decodeMarket(first.market, accountData(first.market)).totalBasis).toBe(before.basis)
  })

  it('keeps the pool and market transactions, with the base-mint signer, when only the config exists', async () => {
    const creator = fund()
    const params = launchParams({ connection: svmConnection(svm), creator: creator.publicKey })
    const first = await buildLaunchPlan(params)
    expect(sendPlanTx(first, 0, creator)).toBeNull()

    const resumed = await buildLaunchPlan({ ...params, ...resumeKeys(first) })

    expect(signerKeys(resumed)).toEqual([[first.baseMint.toBase58()], []])
    expect(programsOf(resumed)[0]).toEqual([DYNAMIC_BONDING_CURVE_PROGRAM_ID.toBase58()])
    execute(resumed, creator)
    expect(decodeMarket(first.market, accountData(first.market)).pool.toBase58()).toBe(first.pool.toBase58())
  })

  it('throws when the existing config does not match the preset', async () => {
    const creator = fund()
    const params = launchParams({ connection: svmConnection(svm), creator: creator.publicKey })
    const first = await buildLaunchPlan(params)
    expect(sendPlanTx(first, 0, creator)).toBeNull()

    await expect(buildLaunchPlan({ ...params, ...resumeKeys(first), preset: { ...params.preset, feeClaimer: Keypair.generate().publicKey } }))
      .rejects.toThrow(/existing config \w+ has fee claimer/)
  })

  it('throws when the existing config has another fee', async () => {
    const creator = fund()
    const params = launchParams({ connection: svmConnection(svm), creator: creator.publicKey })
    const first = await buildLaunchPlan(params)
    expect(sendPlanTx(first, 0, creator)).toBeNull()

    await expect(buildLaunchPlan({ ...params, ...resumeKeys(first), preset: { ...params.preset, feeBps: FEE_BPS / 2 } }))
      .rejects.toThrow(/existing config \w+ has base fee numerator 10000000, expected 5000000/)
  })

  it('throws when an existing pool belongs to another config', async () => {
    const creator = fund()
    const params = launchParams({ connection: svmConnection(svm), creator: creator.publicKey })
    const other = await buildLaunchPlan(params)
    execute(other, creator)
    const configKeypair = Keypair.generate()
    const baseMintKeypair = Keypair.generate()
    plant(deriveDbcPoolAddress(SOL.mint, baseMintKeypair.publicKey, configKeypair.publicKey), other.pool)

    await expect(buildLaunchPlan({ ...params, configKeypair, baseMintKeypair })).rejects.toThrow(/existing pool \w+ has config/)
  })

  it('throws when an existing market belongs to another pool', async () => {
    const creator = fund()
    const params = launchParams({ connection: svmConnection(svm), creator: creator.publicKey })
    const other = await buildLaunchPlan(params)
    execute(other, creator)
    const configKeypair = Keypair.generate()
    const baseMintKeypair = Keypair.generate()
    const pool = deriveDbcPoolAddress(SOL.mint, baseMintKeypair.publicKey, configKeypair.publicKey)
    plant(findMarketPda(pool, localnet.routerProgramId), other.market)

    await expect(buildLaunchPlan({ ...params, configKeypair, baseMintKeypair })).rejects.toThrow(/existing market \w+ has pool/)
  })
})
