/**
 * SDK-25: buildLaunchPlan takes an optional `initialBuyMinOut` and passes it as the initial buy's minOut, in fresh
 * and resumed plans. A resumed launch's market already exists, so its buy runs at the current price; the bound lets
 * the creator's confirmed quote hold on chain (DBC ExceededSlippage) instead of only in the UI.
 */
import { Buffer } from 'buffer'
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  type AccountInfo,
  type BlockhashWithExpiryBlockHeight,
  type TransactionInstruction,
} from '@solana/web3.js'
import { FailedTransactionMetadata, type LiteSVM } from 'litesvm'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  buildLaunchPlan,
  buyInstructions,
  decodeMarket,
  decodePosition,
  decodeTxError,
  findPositionPda,
  getClusterConfig,
  initExtraAccountMetasInstruction,
  initMarketInstruction,
  marketAccountsFor,
  quoteBuy,
} from '../src/index.js'
import type { BuyQuote, LaunchParams, LaunchPlan, MarketAccount, PresetOptions, QuoteMintInfo } from '../src/index.js'
import { LITESVM_SKIP_REASON, litesvmSuiteTitle, setupMarket } from './helpers/litesvm.js'

const FEE_BPS = 100
const CREATOR_LAMPORTS = 10_000_000_000n // 10 SOL
const INITIAL_BUY = 2_000_000n // 0.002 SOL, far below the Anti-Whale cap
const FRONT_RUN_BUY = 2_000_000n // a third party's buy between the creator's first plan and the resume
const U64_MAX = 2n ** 64n - 1n
/** Router buy data: 8-byte discriminator, amount_in u64, min_out u64 (little endian). */
const BUY_DATA_LENGTH = 24
const AMOUNT_IN_OFFSET = 8
const MIN_OUT_OFFSET = 16

/** Fixed launch input keeps the offline tests independent of sibling fixtures. */
const SCENARIO_THRESHOLD = 303_124_998n

const localnet = getClusterConfig('localnet')
const SOL: QuoteMintInfo = (() => {
  const quote = localnet.quoteMints.find((q) => q.symbol === 'SOL')
  if (quote === undefined) throw new Error('localnet has no SOL quote')
  return quote
})()

const presetOf = (): PresetOptions => ({
  quote: SOL,
  migrationQuoteThreshold: SCENARIO_THRESHOLD,
  feeBps: FEE_BPS,
  feeClaimer: Keypair.generate().publicKey,
  leftoverReceiver: Keypair.generate().publicKey,
})

type Accounts = readonly (AccountInfo<Buffer> | null)[]

/** Connection with a scripted blockhash and account reads. */
class StubConnection extends Connection {
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
    return [...this.accounts(publicKeys)]
  }
}

const offlineConnection = (): StubConnection => {
  const blockhash = Keypair.generate().publicKey.toBase58()
  return new StubConnection(() => blockhash, (keys) => keys.map(() => null))
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
  initialBuy: INITIAL_BUY,
  ...overrides,
})

/** The first plan's config and base-mint signers, which a resume passes back. */
const resumeKeys = (plan: LaunchPlan): Pick<LaunchParams, 'configKeypair' | 'baseMintKeypair'> => ({
  configKeypair: plan.signers[0]?.[0],
  baseMintKeypair: plan.signers[1]?.[0],
})

const isRouterBuy = (ix: TransactionInstruction): boolean =>
  ix.programId.equals(localnet.routerProgramId) && ix.data.length === BUY_DATA_LENGTH

/** [amount_in, min_out] of the plan's router buy; throws unless exactly one plan instruction is that buy. */
function buyArgs(plan: LaunchPlan): readonly [amountIn: bigint, minOut: bigint] {
  const buys = plan.transactions.flatMap((tx) => tx.instructions).filter(isRouterBuy)
  if (buys.length !== 1) throw new Error(`expected one router buy in the plan, found ${buys.length}`)
  const data = Buffer.from(buys[0]!.data)
  return [data.readBigUInt64LE(AMOUNT_IN_OFFSET), data.readBigUInt64LE(MIN_OUT_OFFSET)]
}

const routerBuyCount = (plan: LaunchPlan): number => plan.transactions.flatMap((tx) => tx.instructions).filter(isRouterBuy).length

describe('buildLaunchPlan initialBuyMinOut (offline)', () => {
  it('keeps minOut 0 when initialBuyMinOut is absent', async () => {
    const plan = await buildLaunchPlan(launchParams())

    expect(buyArgs(plan)).toEqual([INITIAL_BUY, 0n])
  })

  it.each([
    ['1', 1n],
    ['a quote-sized bound', 123_456_789_012n],
    ['u64 max', U64_MAX],
  ])('uses %s as the minOut of a fresh plan', async (_label, initialBuyMinOut) => {
    const plan = await buildLaunchPlan(launchParams({ initialBuyMinOut }))

    expect(plan.transactions).toHaveLength(3)
    expect(buyArgs(plan)).toEqual([INITIAL_BUY, initialBuyMinOut])
  })

  it('uses it as the minOut of a resumed plan', async () => {
    const initialBuyMinOut = 987_654_321n
    const plan = await buildLaunchPlan(launchParams({
      initialBuyMinOut, configKeypair: Keypair.generate(), baseMintKeypair: Keypair.generate(),
    }))

    expect(buyArgs(plan)).toEqual([INITIAL_BUY, initialBuyMinOut])
  })

  it('adds no buy when initialBuy is 0, whatever the bound', async () => {
    const plan = await buildLaunchPlan(launchParams({ initialBuy: 0n, initialBuyMinOut: 1n }))

    expect(plan.transactions).toHaveLength(3)
    expect(routerBuyCount(plan)).toBe(0)
  })

  it.each([
    ['a negative value', -1n, RangeError],
    ['a value above u64', U64_MAX + 1n, RangeError],
    ['a number', 5 as unknown as bigint, TypeError],
    ['a string', '5' as unknown as bigint, TypeError],
  ])('rejects %s', async (_label, initialBuyMinOut, errorType) => {
    const build = buildLaunchPlan(launchParams({ initialBuyMinOut }))

    await expect(build).rejects.toThrow(errorType)
    await expect(build).rejects.toThrow(/initialBuyMinOut/)
  })
})

describe.skipIf(LITESVM_SKIP_REASON !== null)(litesvmSuiteTitle('buildLaunchPlan initialBuyMinOut on LiteSVM (wSOL, capped router)'), () => {
  let svm: LiteSVM

  beforeAll(async () => {
    ;({ svm } = await setupMarket({ traders: 0 }))
  })

  const fund = (): Keypair => {
    const keypair = Keypair.generate()
    svm.airdrop(keypair.publicKey, CREATOR_LAMPORTS)
    return keypair
  }

  type SendOutcome = { readonly ok: true } | { readonly ok: false; readonly error: string; readonly logs: readonly string[] }

  const sendTx = (tx: Transaction, signers: readonly Keypair[]): SendOutcome => {
    tx.sign(...signers)
    const res = svm.sendTransaction(tx)
    return res instanceof FailedTransactionMetadata
      ? { ok: false, error: res.err().toString(), logs: res.meta().logs() }
      : { ok: true }
  }

  const sendPlanTx = (plan: LaunchPlan, i: number, creator: Keypair): SendOutcome => {
    const tx = plan.transactions[i]
    if (tx === undefined) throw new Error(`plan has no transaction ${i}`)
    return sendTx(tx, [creator, ...(plan.signers[i] ?? [])])
  }

  const sendIxs = (payer: Keypair, ixs: readonly TransactionInstruction[]): SendOutcome =>
    sendTx(new Transaction({ feePayer: payer.publicKey, recentBlockhash: svm.latestBlockhash() }).add(...ixs), [payer])

  const expectOk = (outcome: SendOutcome): void => {
    if (!outcome.ok) throw new Error(`transaction failed: ${outcome.error}\n${outcome.logs.join('\n')}`)
  }

  const accountData = (address: PublicKey): Buffer => {
    const account = svm.getAccount(address)
    if (account === null) throw new Error(`account ${address.toBase58()} does not exist`)
    return Buffer.from(account.data)
  }

  const marketOf = (plan: LaunchPlan): MarketAccount => decodeMarket(plan.market, accountData(plan.market))

  /** A third party sends the permissionless hook init and init_market of `plan`. */
  const openMarketAsThirdParty = (plan: LaunchPlan): void => {
    const thirdParty = fund()
    expectOk(sendIxs(thirdParty, [
      initExtraAccountMetasInstruction(thirdParty.publicKey, plan.baseMint, localnet.hookProgramId),
      initMarketInstruction({
        cluster: localnet, payer: thirdParty.publicKey, pool: plan.pool, config: plan.config, quoteMint: SOL.mint, quoteTokenProgram: SOL.tokenProgram,
      }),
    ]))
  }

  /** A third party buys on the market of `plan`, moving the price before the creator's resumed buy. */
  const buyAsThirdParty = (plan: LaunchPlan): void => {
    const thirdParty = fund()
    expectOk(sendIxs(thirdParty, buyInstructions({
      cluster: localnet, accounts: marketAccountsFor(marketOf(plan), SOL.tokenProgram), user: thirdParty.publicKey, amountIn: FRONT_RUN_BUY, minOut: 0n,
    })))
  }

  interface ResumeScene {
    readonly creator: Keypair
    readonly params: LaunchParams
    readonly first: LaunchPlan
    /** The quote for INITIAL_BUY on the untouched curve, before the third party's buy. */
    readonly staleQuote: BuyQuote
    /** The quote for INITIAL_BUY at the price the resumed buy actually runs at. */
    readonly freshQuote: BuyQuote
  }

  /** The creator lands config and pool; a third party opens the market and buys on it before the creator resumes. */
  const resumeAfterFrontRun = async (): Promise<ResumeScene> => {
    const creator = fund()
    const connection = svmConnection(svm)
    const params = launchParams({ connection, creator: creator.publicKey })
    const first = await buildLaunchPlan(params)
    expectOk(sendPlanTx(first, 0, creator))
    expectOk(sendPlanTx(first, 1, creator))
    openMarketAsThirdParty(first)
    const staleQuote = await quoteBuy(connection, marketOf(first), INITIAL_BUY)
    buyAsThirdParty(first)
    const freshQuote = await quoteBuy(connection, marketOf(first), INITIAL_BUY)
    return { creator, params, first, staleQuote, freshQuote }
  }

  it('moves the price between the stale and the fresh quote', async () => {
    const { staleQuote, freshQuote } = await resumeAfterFrontRun()

    expect(freshQuote.tokensOut).toBeGreaterThan(0n)
    expect(staleQuote.tokensOut).toBeGreaterThan(freshQuote.tokensOut)
  })

  it.each([
    ['the stale quote from before the front-run', (s: ResumeScene) => s.staleQuote.tokensOut],
    ['one unit above the fresh quote', (s: ResumeScene) => s.freshQuote.tokensOut + 1n],
  ])('fails a resumed buy bounded by %s with DBC ExceededSlippage and leaves no position', async (_label, boundOf) => {
    const scene = await resumeAfterFrontRun()
    const { creator, params, first } = scene
    const positionAddress = findPositionPda(first.market, creator.publicKey, localnet.routerProgramId)
    const basisBefore = marketOf(first).totalBasis

    const resumed = await buildLaunchPlan({ ...params, ...resumeKeys(first), initialBuyMinOut: boundOf(scene) })
    expect(resumed.transactions).toHaveLength(1)
    const outcome = sendPlanTx(resumed, 0, creator)

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(decodeTxError({ logs: outcome.logs })).toMatchObject({ program: 'dbc', code: 6002, name: 'ExceededSlippage' })
    expect(svm.getAccount(positionAddress)).toBeNull()
    expect(marketOf(first).totalBasis).toBe(basisBefore)
  })

  it('lands a resumed buy bounded by the fresh quote', async () => {
    const { creator, params, first, freshQuote } = await resumeAfterFrontRun()
    const positionAddress = findPositionPda(first.market, creator.publicKey, localnet.routerProgramId)
    const basisBefore = marketOf(first).totalBasis

    const resumed = await buildLaunchPlan({ ...params, ...resumeKeys(first), initialBuyMinOut: freshQuote.tokensOut })
    expectOk(sendPlanTx(resumed, 0, creator))

    const position = decodePosition(positionAddress, accountData(positionAddress))
    expect(position.owner.toBase58()).toBe(creator.publicKey.toBase58())
    expect(position.tokens).toBe(freshQuote.tokensOut)
    expect(position.basis).toBe(freshQuote.basisAdded)
    expect(marketOf(first).totalBasis).toBe(basisBefore + position.basis)
  })

  it('fails the whole open-market transaction of a fresh plan whose bound the first trade cannot meet', async () => {
    const creator = fund()
    const plan = await buildLaunchPlan(launchParams({ connection: svmConnection(svm), creator: creator.publicKey, initialBuyMinOut: U64_MAX }))
    expectOk(sendPlanTx(plan, 0, creator))
    expectOk(sendPlanTx(plan, 1, creator))

    const outcome = sendPlanTx(plan, 2, creator)

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(decodeTxError({ logs: outcome.logs })).toMatchObject({ program: 'dbc', code: 6002, name: 'ExceededSlippage' })
    expect(svm.getAccount(plan.market)).toBeNull()
  })
})
