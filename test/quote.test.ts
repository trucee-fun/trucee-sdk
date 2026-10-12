/**
 * SDK-04: buy and exit quotes and "Your floor". Unit vectors pin the refund math to zpvp_router math.rs; the
 * LiteSVM suite checks quoteBuy, quoteExit and floorValue against the router's BuyEvent and SellEvent.
 */
import { randomInt } from 'node:crypto'
import { Buffer } from 'buffer'
import { Keypair, PublicKey, type AccountInfo, type Connection, type TransactionInstruction } from '@solana/web3.js'
import { NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token'
import type { LiteSVM } from 'litesvm'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  DUST_PER_BUY,
  HAIRCUT_PER_EXIT,
  basisForExit,
  buyInstructions,
  decodeMarket,
  decodePosition,
  findPositionPda,
  floorValue,
  getClusterConfig,
  parseRouterEvents,
  quoteBuy,
  quoteExit,
  refundFor,
  sellInstructions,
} from '../src/index.js'
import type { BuyEvent, MarketAccount, PositionAccount, RouterEvent, SellEvent } from '../src/index.js'
import {
  CONFIG_MIGRATION_QUOTE_THRESHOLD_OFFSET,
  CONFIG_SWAP_BASE_AMOUNT_OFFSET,
  LITESVM_SKIP_REASON,
  isCurveComplete,
  litesvmSuiteTitle,
  readU64,
  setupMarket,
  tokenAmount,
  type MarketSetup,
} from './helpers/litesvm.js'

const cluster = getClusterConfig('localnet')
const U64_MAX = 2n ** 64n - 1n
const ONE_PERCENT = 10_000_000n

const key = (): PublicKey => Keypair.generate().publicKey

function marketFixture(feeNumerator: bigint, address: PublicKey = key()): MarketAccount {
  return {
    address, pool: key(), config: key(), baseMint: key(), quoteMint: NATIVE_MINT, baseVault: key(), quoteVault: key(),
    bufferVault: key(), feeNumerator, bump: 255, totalBasis: 0n, finalized: false, surplusSnapshot: 0n, basisSnapshot: 0n,
    surplusClaimed: 0n,
  }
}

function positionFixture(market: MarketAccount, tokens: bigint, basis: bigint): PositionAccount {
  return { address: key(), owner: key(), market: market.address, tokens, basis, bump: 254, autoExitDeadline: null }
}

/** A Connection that must never be reached: proves validation happens before any RPC call. */
const unreachableConnection = new Proxy({}, {
  get: (_, prop) => () => { throw new Error(`unexpected RPC call: ${String(prop)}`) },
}) as unknown as Connection

/** The one RPC method quoteBuy uses, answered from a fixed account map. */
const staticConnection = (accounts: ReadonlyMap<string, AccountInfo<Buffer> | null>): Connection => ({
  getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map((k) => accounts.get(k.toBase58()) ?? null),
}) as unknown as Connection

/** quoteBuy's RPC surface served from LiteSVM state. */
const svmConnection = (svm: LiteSVM): Connection => ({
  getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map((k) => {
    const account = svm.getAccount(k)
    return account === null ? null : { ...account, data: Buffer.from(account.data) }
  }),
}) as unknown as Connection

describe('refundFor (math.rs refund_for)', () => {
  it('matches the math.rs vectors', () => {
    expect(refundFor(1_000_000_000n, ONE_PERCENT)).toBe(989_999_998n)
    expect(refundFor(1n, ONE_PERCENT)).toBe(0n)
  })

  it('charges the at-cost fee rounded up, then the per-exit haircut', () => {
    expect(refundFor(100n, ONE_PERCENT)).toBe(97n) // fee ceil(1.00) = 1
    expect(refundFor(101n, ONE_PERCENT)).toBe(97n) // fee ceil(1.01) = 2
    expect(refundFor(3n, 0n)).toBe(1n)
  })

  it('saturates at zero and never overflows u64', () => {
    expect(refundFor(0n, ONE_PERCENT)).toBe(0n)
    expect(refundFor(2n, 0n)).toBe(0n)
    expect(refundFor(U64_MAX, 0n)).toBe(U64_MAX - HAIRCUT_PER_EXIT)
    expect(refundFor(U64_MAX, U64_MAX)).toBe(0n)
  })

  it('rejects amounts that are not u64 bigints', () => {
    expect(() => refundFor(-1n, ONE_PERCENT)).toThrow(RangeError)
    expect(() => refundFor(U64_MAX + 1n, ONE_PERCENT)).toThrow(/basisPart/)
    expect(() => refundFor(1n, -1n)).toThrow(/feeNumerator/)
    expect(() => refundFor(5 as unknown as bigint, ONE_PERCENT)).toThrow(TypeError)
  })
})

describe('basisForExit (math.rs basis_for_exit)', () => {
  it('matches the math.rs vectors', () => {
    expect(basisForExit(3n, 10n, 1n)).toBe(3n)
    expect(basisForExit(3n, 10n, 3n)).toBe(10n)
    expect(basisForExit(3n, 10n, 4n)).toBeNull()
    expect(basisForExit(3n, 10n, 0n)).toBeNull()
  })

  it('floors the pro-rata part without overflow and gives a full exit the whole basis', () => {
    expect(basisForExit(U64_MAX, U64_MAX, U64_MAX - 1n)).toBe(U64_MAX - 1n)
    expect(basisForExit(7n, 100n, 6n)).toBe(85n) // 600 / 7 = 85.7
    expect(basisForExit(0n, 0n, 1n)).toBeNull()
  })

  it('rejects amounts that are not u64 bigints', () => {
    expect(() => basisForExit(-1n, 10n, 1n)).toThrow(/positionTokens/)
    expect(() => basisForExit(3n, U64_MAX + 1n, 1n)).toThrow(/positionBasis/)
    expect(() => basisForExit(3n, 10n, 1 as unknown as bigint)).toThrow(TypeError)
  })
})

describe('floorValue and quoteExit', () => {
  const market = marketFixture(ONE_PERCENT)

  it('floorValue is refundFor(position basis, market fee)', () => {
    expect(floorValue(positionFixture(market, 1_000n, 1_000_000_000n), market)).toBe(989_999_998n)
    expect(floorValue(positionFixture(market, 0n, 0n), market)).toBe(0n)
  })

  it('quoteExit splits a partial exit into basis part, at-cost fee and refund', () => {
    const position = positionFixture(market, 1_000_000n, 500_000_000n)
    expect(quoteExit(position, market, 250_000n)).toEqual({ basisPart: 125_000_000n, feeAtCost: 1_250_000n, refund: 123_749_998n })
  })

  it('a full exit refunds exactly the floor', () => {
    const position = positionFixture(market, 1_000_000n, 500_000_003n)
    const quote = quoteExit(position, market, position.tokens)
    expect(quote.basisPart).toBe(position.basis)
    expect(quote.feeAtCost).toBe(5_000_001n) // ceil(5_000_000.03)
    expect(quote.refund).toBe(floorValue(position, market))
  })

  it('rejects an exit of zero tokens or more than the position (router InvalidExitAmount)', () => {
    const position = positionFixture(market, 10n, 100n)
    expect(() => quoteExit(position, market, 0n)).toThrow(RangeError)
    expect(() => quoteExit(position, market, 11n)).toThrow(/tokens/)
  })

  it('rejects a position of another market', () => {
    const position = positionFixture(marketFixture(ONE_PERCENT), 10n, 100n)
    expect(() => floorValue(position, market)).toThrow(/market/)
    expect(() => quoteExit(position, market, 1n)).toThrow(/market/)
  })
})

describe('quoteBuy input validation', () => {
  const market = marketFixture(ONE_PERCENT)

  it.each([
    ['zero', 0n],
    ['negative', -1n],
    ['above u64', U64_MAX + 1n],
  ])('rejects a %s amountIn before any RPC call', async (_, amountIn) => {
    await expect(quoteBuy(unreachableConnection, market, amountIn)).rejects.toThrow(/amountIn/)
  })

  it('rejects a number amountIn (amounts are bigint base units)', async () => {
    await expect(quoteBuy(unreachableConnection, market, 5 as unknown as bigint)).rejects.toThrow(TypeError)
  })

  it('rejects a missing pool or config account, naming it', async () => {
    await expect(quoteBuy(staticConnection(new Map()), market, 1_000n)).rejects.toThrow(market.pool.toBase58())
  })

  it('rejects accounts not owned by the DBC program', async () => {
    const foreign: AccountInfo<Buffer> = { data: Buffer.alloc(1_200), owner: key(), lamports: 1, executable: false, rentEpoch: 0 }
    const accounts = new Map([[market.pool.toBase58(), foreign], [market.config.toBase58(), foreign]])
    await expect(quoteBuy(staticConnection(accounts), market, 1_000n)).rejects.toThrow(/DBC program/)
  })
})

/* ---------- LiteSVM: quotes against the router's events ---------- */

const RANDOM_BUYS = 5
/** Random buy sizes as threshold fractions: small enough that 5 distinct buyers stay far below the Anti-Whale cap. */
const MIN_BUY_DIVISOR = 200n
const MAX_BUY_DIVISOR = 40n
const GRADUATION_CHUNKS = 60n
const MAX_GRADUATION_BUYS = 400
/** Anti-Whale (ONC-04): no position above 20% of the config's swap_base_amount. */
const WHALE_CAP_DIVISOR = 5n
const TINY_MIGRATION_QUOTE_THRESHOLD = 303_124_998n
const SUITE_TIMEOUT_MS = 120_000
/** DBC rounds the curve output in the pool's favour; the SDK's off-chain math may differ by one raw unit. */
const TOKENS_OUT_TOLERANCE = 1n

const SEED = randomInt(2 ** 31)
/** mulberry32: a reproducible stream of uniform u32 values; the seed is in every failure message. */
function prng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return (t ^ (t >>> 14)) >>> 0
  }
}
const nextU32 = prng(SEED)
const randomBetween = (lo: bigint, hi: bigint): bigint => lo + ((hi - lo + 1n) * BigInt(nextU32())) / 2n ** 32n

const abs = (x: bigint): bigint => (x < 0n ? -x : x)
const eventOf = <N extends RouterEvent['name']>(logs: readonly string[], name: N): Extract<RouterEvent, { name: N }> => {
  const event = parseRouterEvents(logs, cluster.routerProgramId).find((e) => e.name === name)
  if (event === undefined) throw new Error(`no ${name} in logs:\n${logs.join('\n')}`)
  return event as Extract<RouterEvent, { name: N }>
}

describe.skipIf(LITESVM_SKIP_REASON !== null)(litesvmSuiteTitle('quotes on LiteSVM (wSOL quote, capped router)'), () => {
  let setup: MarketSetup
  let connection: Connection
  let threshold: bigint
  let whaleCap: bigint

  const sendOk = (payer: Keypair, ixs: readonly TransactionInstruction[]): readonly string[] => {
    const res = setup.send(payer, ixs)
    if (!res.ok) throw new Error(`transaction failed (seed ${SEED}): ${res.error}\n${res.logs.slice(-6).join('\n')}`)
    return res.logs
  }
  const marketState = (): MarketAccount => {
    const account = setup.svm.getAccount(setup.accounts.market)
    if (account === null) throw new Error('market account missing')
    return decodeMarket(setup.accounts.market, Buffer.from(account.data))
  }
  const positionOf = (owner: PublicKey): PositionAccount | null => {
    const address = findPositionPda(setup.accounts.market, owner, cluster.routerProgramId)
    const account = setup.svm.getAccount(address)
    return account === null ? null : decodePosition(address, Buffer.from(account.data))
  }
  const quoteAtaOf = (owner: PublicKey) => getAssociatedTokenAddressSync(NATIVE_MINT, owner, false, TOKEN_PROGRAM_ID)
  const buy = (trader: Keypair, amountIn: bigint): BuyEvent => {
    const logs = sendOk(trader, buyInstructions({ cluster, accounts: setup.accounts, user: trader.publicKey, amountIn, minOut: 1n }))
    const tokens = positionOf(trader.publicKey)?.tokens ?? 0n
    expect(tokens <= whaleCap, `position ${tokens} above the Anti-Whale cap ${whaleCap}`).toBe(true)
    return eventOf(logs, 'BuyEvent')
  }
  const sell = (trader: Keypair, tokens: bigint): SellEvent =>
    eventOf(sendOk(trader, sellInstructions({ cluster, accounts: setup.accounts, user: trader.publicKey, tokens, unwrapSol: false })), 'SellEvent')

  /** Quotes a buy, sends it, and checks the quote against the router's BuyEvent. */
  const quotedBuy = async (trader: Keypair, amountIn: bigint) => {
    const quote = await quoteBuy(connection, marketState(), amountIn)
    const basisBefore = positionOf(trader.publicKey)?.basis ?? 0n
    const event = buy(trader, amountIn)
    const context = `seed ${SEED}, amountIn ${amountIn}, quote ${JSON.stringify(quote, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`
    expect(quote.netIntoCurve, context).toBe(event.netIntoCurve)
    expect(abs(quote.tokensOut - event.tokensOut) <= TOKENS_OUT_TOLERANCE, `${context}, tokens_out ${event.tokensOut}`).toBe(true)
    expect(quote.basisAdded, context).toBe(event.basis - basisBefore)
    expect(quote.basisAdded, context).toBe(quote.netIntoCurve - DUST_PER_BUY)
    return { quote, event }
  }

  /** Quotes an exit and the floor, sells, and checks both against the router's SellEvent and the refund paid. */
  const quotedSell = (trader: Keypair, tokens: bigint) => {
    const market = marketState()
    const before = positionOf(trader.publicKey)!
    const quote = quoteExit(before, market, tokens)
    const floor = floorValue(before, market)
    const quoteBefore = tokenAmount(setup.svm, quoteAtaOf(trader.publicKey))
    const event = sell(trader, tokens)
    const context = `seed ${SEED}, position ${before.tokens}/${before.basis}, tokens ${tokens}`
    expect(quote.basisPart, context).toBe(event.basisPart)
    expect(quote.refund, context).toBe(event.refund)
    expect(tokenAmount(setup.svm, quoteAtaOf(trader.publicKey)) - quoteBefore, context).toBe(event.refund)
    expect(quote.basisPart - quote.feeAtCost - HAIRCUT_PER_EXIT, context).toBe(quote.refund)
    return { quote, floor, event }
  }

  beforeAll(async () => {
    setup = await setupMarket({ traders: 6 })
    connection = svmConnection(setup.svm)
    threshold = readU64(setup.svm, setup.accounts.config, CONFIG_MIGRATION_QUOTE_THRESHOLD_OFFSET)
    whaleCap = readU64(setup.svm, setup.accounts.config, CONFIG_SWAP_BASE_AMOUNT_OFFSET) / WHALE_CAP_DIVISOR
  }, SUITE_TIMEOUT_MS)

  it(`quoteBuy matches ${RANDOM_BUYS} random router buys: net_into_curve exactly, tokens_out within 1 raw unit`, async () => {
    expect(threshold).toBe(TINY_MIGRATION_QUOTE_THRESHOLD)
    for (let i = 0; i < RANDOM_BUYS; i++) {
      const amountIn = randomBetween(threshold / MIN_BUY_DIVISOR, threshold / MAX_BUY_DIVISOR)
      const { quote } = await quotedBuy(setup.traders[i]!, amountIn)
      expect(quote.fee + quote.netIntoCurve, `seed ${SEED}`).toBe(amountIn) // fully filled: fee charged on the input
      expect(quote.fee > 0n).toBe(true)
    }
  })

  it('quoteExit.refund equals the SellEvent refund for partial and random exits', () => {
    const [half, random] = setup.traders
    quotedSell(half!, positionOf(half!.publicKey)!.tokens / 2n)
    quotedSell(random!, randomBetween(1n, positionOf(random!.publicKey)!.tokens - 1n))
  })

  it('a full exit pays exactly floorValue ("Your floor") and returns the whole basis', () => {
    const trader = setup.traders[2]!
    const position = positionOf(trader.publicKey)!
    const { floor, event } = quotedSell(trader, position.tokens)
    expect(event.refund).toBe(floor)
    expect(event.basisPart).toBe(position.basis)
    expect(floor > 0n).toBe(true)
  })

  it('quoteBuy matches every buy up to the partial-fill buy that graduates the curve, then reports it complete', async () => {
    const chunk = threshold / GRADUATION_CHUNKS
    const holding = (t: Keypair): bigint => positionOf(t.publicKey)?.tokens ?? 0n
    let last: Awaited<ReturnType<typeof quotedBuy>> | null = null
    for (let n = 0; n < MAX_GRADUATION_BUYS && !isCurveComplete(setup.svm, setup.accounts.pool); n++) {
      const smallest = setup.traders.reduce((min, t) => (holding(t) < holding(min) ? t : min))
      last = await quotedBuy(smallest, chunk)
    }

    expect(isCurveComplete(setup.svm, setup.accounts.pool)).toBe(true)
    // the graduating buy is partially filled: only the input up to the migration price is charged
    expect(last!.quote.fee + last!.quote.netIntoCurve < chunk).toBe(true)
    setup.traders.forEach((t) => expect(holding(t) <= whaleCap, `position above cap ${whaleCap}`).toBe(true))
    await expect(quoteBuy(connection, marketState(), chunk)).rejects.toThrow(/complete/)
  }, SUITE_TIMEOUT_MS)
})
