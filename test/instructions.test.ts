/**
 * SDK-02: router and hook instruction builders. Unit tests pin data layouts and account orders (mirrored from
 * litesvm-diff/src/fixture.ts); the LiteSVM lifecycle drives one wSOL market from first buy to surplus claims.
 */
import { createHash } from 'node:crypto'
import { Buffer } from 'buffer'
import { Keypair, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, SystemProgram, type AccountMeta, type TransactionInstruction } from '@solana/web3.js'
import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import { deriveDbcEventAuthority, deriveDbcPoolAuthority } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  DUST_PER_BUY,
  FEE_DENOMINATOR,
  HAIRCUT_PER_EXIT,
  buyInstructions,
  claimSurplusInstruction,
  decodeMarket,
  decodePosition,
  finalizeInstruction,
  findBufferPda,
  findExtraAccountMetasPda,
  findMarketPda,
  findPositionPda,
  getClusterConfig,
  initExtraAccountMetasInstruction,
  initMarketInstruction,
  parseRouterEvents,
  sellInstructions,
} from '../src/index.js'
import type { BuyEvent, MarketAccount, MarketAccounts, PositionAccount, RouterEvent, SellEvent } from '../src/index.js'
import {
  CONFIG_MIGRATION_QUOTE_THRESHOLD_OFFSET,
  CONFIG_SWAP_BASE_AMOUNT_OFFSET,
  POOL_MIGRATION_PROGRESS_OFFSET,
  isCurveComplete,
  readU64,
  setupMarket,
  tokenAmount,
  type MarketSetup,
} from './helpers/litesvm.js'

const cluster = getClusterConfig('localnet')
const U64_MAX = 2n ** 64n - 1n

const anchorDiscriminator = (name: string): Buffer =>
  Buffer.from(createHash('sha256').update(`global:${name}`).digest().subarray(0, 8))
const u64le = (value: bigint): Buffer => {
  const out = Buffer.alloc(8)
  out.writeBigUInt64LE(value)
  return out
}
const meta = (pubkey: PublicKey, isWritable = false, isSigner = false) => ({ pubkey: pubkey.toBase58(), isSigner, isWritable })
const keysOf = (ix: TransactionInstruction) =>
  ix.keys.map((k: AccountMeta) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable }))
const dataOf = (ix: TransactionInstruction): string => Buffer.from(ix.data).toString('hex')

function marketAccounts(quoteMint: PublicKey, quoteTokenProgram: PublicKey): MarketAccounts {
  const pool = Keypair.generate().publicKey
  const market = findMarketPda(pool, cluster.routerProgramId)
  return {
    market, pool, config: Keypair.generate().publicKey, baseMint: Keypair.generate().publicKey, quoteMint,
    baseVault: Keypair.generate().publicKey, quoteVault: Keypair.generate().publicKey,
    bufferVault: findBufferPda(market, cluster.routerProgramId), quoteTokenProgram,
  }
}

/** Router buy/sell account list: Swap accounts, then [extra metas, instructions sysvar, hook program]. */
function expectedSwapKeys(a: MarketAccounts, user: PublicKey) {
  return [
    meta(user, true, true), meta(a.market, true), meta(findPositionPda(a.market, user, cluster.routerProgramId), true),
    meta(getAssociatedTokenAddressSync(a.quoteMint, user, false, a.quoteTokenProgram), true),
    meta(getAssociatedTokenAddressSync(a.baseMint, user, false, TOKEN_2022_PROGRAM_ID), true), meta(a.bufferVault, true),
    meta(deriveDbcPoolAuthority()), meta(a.config), meta(a.pool, true), meta(a.baseVault, true), meta(a.quoteVault, true),
    meta(a.baseMint, true), meta(a.quoteMint), meta(TOKEN_2022_PROGRAM_ID), meta(a.quoteTokenProgram),
    meta(deriveDbcEventAuthority()), meta(cluster.dbcProgramId), meta(SystemProgram.programId),
    meta(findExtraAccountMetasPda(a.baseMint, cluster.hookProgramId)), meta(SYSVAR_INSTRUCTIONS_PUBKEY), meta(cluster.hookProgramId),
  ]
}

describe('instruction data', () => {
  const accounts = marketAccounts(NATIVE_MINT, TOKEN_PROGRAM_ID)
  const user = Keypair.generate().publicKey

  it('buy = sha256("global:buy")[..8] | amount_in u64 | min_out u64', () => {
    const ixs = buyInstructions({ cluster, accounts, user, amountIn: U64_MAX, minOut: 0x0102030405060708n })
    const buy = ixs[ixs.length - 1]!
    expect(dataOf(buy)).toBe(Buffer.concat([anchorDiscriminator('buy'), u64le(U64_MAX), u64le(0x0102030405060708n)]).toString('hex'))
  })

  it('sell = sha256("global:sell")[..8] | tokens u64', () => {
    const [sell] = sellInstructions({ cluster, accounts, user, tokens: 1_234_567n, unwrapSol: false })
    expect(dataOf(sell!)).toBe(Buffer.concat([anchorDiscriminator('sell'), u64le(1_234_567n)]).toString('hex'))
  })

  it.each([
    ['finalize', () => finalizeInstruction({ cluster, market: accounts.market, pool: accounts.pool, bufferVault: accounts.bufferVault })],
    ['claim_surplus', () => claimSurplusInstruction({ cluster, accounts, cranker: user, owner: user })],
    ['init_market', () => initMarketInstruction({ cluster, payer: user, pool: accounts.pool, config: accounts.config, quoteMint: NATIVE_MINT, quoteTokenProgram: TOKEN_PROGRAM_ID })],
    ['initialize_extra_account_meta_list', () => initExtraAccountMetasInstruction(user, accounts.baseMint)],
  ] as const)('%s = sha256("global:<name>")[..8] and nothing else', (name, build) => {
    expect(dataOf(build())).toBe(anchorDiscriminator(name).toString('hex'))
  })
})

describe('account orders', () => {
  const user = Keypair.generate().publicKey

  it('buyInstructions with a native quote: quote ATA, base ATA, wrap, syncNative, router buy', () => {
    const accounts = marketAccounts(NATIVE_MINT, TOKEN_PROGRAM_ID)
    const quoteAta = getAssociatedTokenAddressSync(NATIVE_MINT, user, false, TOKEN_PROGRAM_ID)
    const baseAta = getAssociatedTokenAddressSync(accounts.baseMint, user, false, TOKEN_2022_PROGRAM_ID)
    const ixs = buyInstructions({ cluster, accounts, user, amountIn: 5_000n, minOut: 7n })
    expect(ixs).toHaveLength(5)
    expect(ixs[0]).toEqual(createAssociatedTokenAccountIdempotentInstruction(user, quoteAta, user, NATIVE_MINT, TOKEN_PROGRAM_ID))
    expect(ixs[1]).toEqual(createAssociatedTokenAccountIdempotentInstruction(user, baseAta, user, accounts.baseMint, TOKEN_2022_PROGRAM_ID))
    expect(ixs[2]).toEqual(SystemProgram.transfer({ fromPubkey: user, toPubkey: quoteAta, lamports: 5_000n }))
    expect(ixs[3]).toEqual(createSyncNativeInstruction(quoteAta, TOKEN_PROGRAM_ID))
    expect(ixs[4]!.programId.equals(cluster.routerProgramId)).toBe(true)
    expect(keysOf(ixs[4]!)).toEqual(expectedSwapKeys(accounts, user))
  })

  it('buyInstructions with a non-native quote skips the wrap and uses the quote token program', () => {
    const accounts = marketAccounts(Keypair.generate().publicKey, TOKEN_2022_PROGRAM_ID)
    const ixs = buyInstructions({ cluster, accounts, user, amountIn: 5_000n, minOut: 0n })
    expect(ixs).toHaveLength(3)
    const quoteAta = getAssociatedTokenAddressSync(accounts.quoteMint, user, false, TOKEN_2022_PROGRAM_ID)
    expect(ixs[0]).toEqual(createAssociatedTokenAccountIdempotentInstruction(user, quoteAta, user, accounts.quoteMint, TOKEN_2022_PROGRAM_ID))
    expect(keysOf(ixs[2]!)).toEqual(expectedSwapKeys(accounts, user))
  })

  it('sellInstructions: router sell, plus closeAccount of the wSOL ATA only when unwrapping a native quote', () => {
    const native = marketAccounts(NATIVE_MINT, TOKEN_PROGRAM_ID)
    const quoteAta = getAssociatedTokenAddressSync(NATIVE_MINT, user, false, TOKEN_PROGRAM_ID)
    const kept = sellInstructions({ cluster, accounts: native, user, tokens: 10n, unwrapSol: false })
    expect(kept).toHaveLength(1)
    expect(keysOf(kept[0]!)).toEqual(expectedSwapKeys(native, user))

    const unwrapped = sellInstructions({ cluster, accounts: native, user, tokens: 10n, unwrapSol: true })
    expect(unwrapped).toHaveLength(2)
    expect(unwrapped[0]).toEqual(kept[0])
    expect(unwrapped[1]).toEqual(createCloseAccountInstruction(quoteAta, user, user, [], TOKEN_PROGRAM_ID))

    const token = marketAccounts(Keypair.generate().publicKey, TOKEN_2022_PROGRAM_ID)
    expect(sellInstructions({ cluster, accounts: token, user, tokens: 10n, unwrapSol: true })).toHaveLength(1)
  })

  it('finalizeInstruction: market (w), pool, buffer', () => {
    const accounts = marketAccounts(NATIVE_MINT, TOKEN_PROGRAM_ID)
    const ix = finalizeInstruction({ cluster, market: accounts.market, pool: accounts.pool, bufferVault: accounts.bufferVault })
    expect(ix.programId.equals(cluster.routerProgramId)).toBe(true)
    expect(keysOf(ix)).toEqual([meta(accounts.market, true), meta(accounts.pool), meta(accounts.bufferVault)])
  })

  it("claimSurplusInstruction: the cranker signs, the share goes to the owner's canonical quote ATA", () => {
    const accounts = marketAccounts(NATIVE_MINT, TOKEN_PROGRAM_ID)
    const cranker = Keypair.generate().publicKey
    const ix = claimSurplusInstruction({ cluster, accounts, cranker, owner: user })
    expect(ix.programId.equals(cluster.routerProgramId)).toBe(true)
    expect(keysOf(ix)).toEqual([
      meta(cranker, false, true), meta(user, true), meta(accounts.market, true),
      meta(findPositionPda(accounts.market, user, cluster.routerProgramId), true),
      meta(getAssociatedTokenAddressSync(NATIVE_MINT, user, false, TOKEN_PROGRAM_ID), true), meta(accounts.bufferVault, true),
      meta(NATIVE_MINT), meta(TOKEN_PROGRAM_ID),
    ])
  })

  it('initMarketInstruction: payer, pool, config, quote mint, market, buffer, quote token program, system program', () => {
    const pool = Keypair.generate().publicKey
    const config = Keypair.generate().publicKey
    const market = findMarketPda(pool, cluster.routerProgramId)
    const ix = initMarketInstruction({ cluster, payer: user, pool, config, quoteMint: NATIVE_MINT, quoteTokenProgram: TOKEN_PROGRAM_ID })
    expect(ix.programId.equals(cluster.routerProgramId)).toBe(true)
    expect(keysOf(ix)).toEqual([
      meta(user, true, true), meta(pool), meta(config), meta(NATIVE_MINT), meta(market, true),
      meta(findBufferPda(market, cluster.routerProgramId), true), meta(TOKEN_PROGRAM_ID), meta(SystemProgram.programId),
    ])
  })

  it('initExtraAccountMetasInstruction: payer, extra metas PDA, base mint, system program under the hook', () => {
    const baseMint = Keypair.generate().publicKey
    const otherHook = Keypair.generate().publicKey
    const ix = initExtraAccountMetasInstruction(user, baseMint, otherHook)
    expect(ix.programId.equals(otherHook)).toBe(true)
    expect(keysOf(ix)).toEqual([
      meta(user, true, true), meta(findExtraAccountMetasPda(baseMint, otherHook), true), meta(baseMint), meta(SystemProgram.programId),
    ])
    expect(initExtraAccountMetasInstruction(user, baseMint).programId.equals(cluster.hookProgramId)).toBe(true)
  })
})

describe('input validation', () => {
  const accounts = marketAccounts(NATIVE_MINT, TOKEN_PROGRAM_ID)
  const user = Keypair.generate().publicKey

  const badBuyAmounts: Array<[label: string, amountIn: bigint, minOut: bigint, message: RegExp]> = [
    ['zero amountIn', 0n, 0n, /amountIn/],
    ['negative amountIn', -1n, 0n, /amountIn/],
    ['amountIn above u64', U64_MAX + 1n, 0n, /amountIn/],
    ['negative minOut', 1n, -1n, /minOut/],
    ['minOut above u64', 1n, U64_MAX + 1n, /minOut/],
  ]
  it.each(badBuyAmounts)('buyInstructions rejects %s', (_, amountIn, minOut, message) => {
    expect(() => buyInstructions({ cluster, accounts, user, amountIn, minOut })).toThrow(message)
  })

  it('buyInstructions rejects a number amount (amounts are bigint base units)', () => {
    expect(() => buyInstructions({ cluster, accounts, user, amountIn: 5 as unknown as bigint, minOut: 0n })).toThrow(TypeError)
  })

  it('sellInstructions rejects zero tokens, tokens above u64 and a non-boolean unwrapSol', () => {
    expect(() => sellInstructions({ cluster, accounts, user, tokens: 0n, unwrapSol: false })).toThrow(/tokens/)
    expect(() => sellInstructions({ cluster, accounts, user, tokens: U64_MAX + 1n, unwrapSol: false })).toThrow(/tokens/)
    expect(() => sellInstructions({ cluster, accounts, user, tokens: 1n, unwrapSol: 'yes' as unknown as boolean })).toThrow(/unwrapSol/)
  })

  it('rejects missing or non-PublicKey accounts with the field name', () => {
    const noBuffer = { ...accounts, bufferVault: undefined } as unknown as MarketAccounts
    expect(() => buyInstructions({ cluster, accounts: noBuffer, user, amountIn: 1n, minOut: 0n })).toThrow(/bufferVault/)
    expect(() => claimSurplusInstruction({ cluster, accounts, cranker: 'me' as unknown as PublicKey, owner: user })).toThrow(/cranker/)
    expect(() => finalizeInstruction({ cluster, market: accounts.market, pool: null as unknown as PublicKey, bufferVault: accounts.bufferVault })).toThrow(/pool/)
  })
})

/* ---------- LiteSVM lifecycle ---------- */

const TINY_MIGRATION_QUOTE_THRESHOLD = 303_124_998n
/**
 * Buy sizes as fractions of the migration threshold. The early curve is cheap (threshold/10 there buys ~25% of
 * swap_base_amount), so every buy is small and graduation buys go to the smallest holder first (Anti-Whale).
 */
const FIRST_BUY_DIVISOR = 60n
const PRICE_RAISE_BUY_DIVISOR = 30n
const GRADUATION_CHUNKS = 60n
const MAX_GRADUATION_BUYS = 400
/** Anti-Whale (ONC-04): no position above 20% of the config's swap_base_amount. */
const WHALE_CAP_DIVISOR = 5n
const LITESVM_SIGNATURE_FEE = 5_000n
const LIFECYCLE_TIMEOUT_MS = 120_000

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b
const refundForBasis = (basisPart: bigint, feeNumerator: bigint): bigint => {
  const refund = basisPart - ceilDiv(basisPart * feeNumerator, FEE_DENOMINATOR) - HAIRCUT_PER_EXIT
  return refund > 0n ? refund : 0n
}
const eventOf = <N extends RouterEvent['name']>(logs: readonly string[], name: N): Extract<RouterEvent, { name: N }> => {
  const event = parseRouterEvents(logs, cluster.routerProgramId).find((e) => e.name === name)
  if (event === undefined) throw new Error(`no ${name} in logs:\n${logs.join('\n')}`)
  return event as Extract<RouterEvent, { name: N }>
}

describe('lifecycle on LiteSVM (wSOL quote, capped router)', () => {
  let setup: MarketSetup
  let cranker: Keypair
  let threshold: bigint
  let whaleCap: bigint

  const sendOk = (payer: Keypair, ixs: readonly TransactionInstruction[]): readonly string[] => {
    const res = setup.send(payer, ixs)
    if (!res.ok) throw new Error(`transaction failed: ${res.error}\n${res.logs.slice(-6).join('\n')}`)
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
  const baseAtaOf = (owner: PublicKey) => getAssociatedTokenAddressSync(setup.accounts.baseMint, owner, false, TOKEN_2022_PROGRAM_ID)
  /** Router buy that must succeed and must leave the buyer at or under the Anti-Whale cap. */
  const buy = (trader: Keypair, amountIn: bigint): BuyEvent => {
    const logs = sendOk(trader, buyInstructions({ cluster, accounts: setup.accounts, user: trader.publicKey, amountIn, minOut: 1n }))
    const tokens = positionOf(trader.publicKey)?.tokens ?? 0n
    expect(tokens <= whaleCap, `position ${tokens} above the Anti-Whale cap ${whaleCap}`).toBe(true)
    return eventOf(logs, 'BuyEvent')
  }
  const sell = (trader: Keypair, tokens: bigint, unwrapSol: boolean): SellEvent =>
    eventOf(sendOk(trader, sellInstructions({ cluster, accounts: setup.accounts, user: trader.publicKey, tokens, unwrapSol })), 'SellEvent')
  const lamportsOf = (address: PublicKey): bigint => setup.svm.getBalance(address) ?? 0n

  beforeAll(async () => {
    setup = await setupMarket({ traders: 6 })
    cranker = Keypair.generate()
    setup.svm.airdrop(cranker.publicKey, 10_000_000_000n)
    threshold = readU64(setup.svm, setup.accounts.config, CONFIG_MIGRATION_QUOTE_THRESHOLD_OFFSET)
    whaleCap = readU64(setup.svm, setup.accounts.config, CONFIG_SWAP_BASE_AMOUNT_OFFSET) / WHALE_CAP_DIVISOR
  }, LIFECYCLE_TIMEOUT_MS)

  it('setup: init_market opened the market and the hook wrote its extra metas', () => {
    expect(threshold).toBe(TINY_MIGRATION_QUOTE_THRESHOLD)
    const market = marketState()
    expect(market.pool.equals(setup.accounts.pool)).toBe(true)
    expect(market.baseMint.equals(setup.accounts.baseMint)).toBe(true)
    expect(market.quoteMint.equals(NATIVE_MINT)).toBe(true)
    expect(market.bufferVault.equals(setup.accounts.bufferVault)).toBe(true)
    expect(market.totalBasis).toBe(0n)
    const extraMetas = setup.svm.getAccount(findExtraAccountMetasPda(setup.accounts.baseMint, cluster.hookProgramId))
    expect(extraMetas?.owner.equals(cluster.hookProgramId)).toBe(true)
  })

  it('wrap + buy: the pool receives exactly amount_in and the position records basis = net - dust', () => {
    const [trader] = setup.traders
    const amountIn = threshold / FIRST_BUY_DIVISOR
    const vaultBefore = tokenAmount(setup.svm, setup.accounts.quoteVault)
    const event = buy(trader!, amountIn)
    const position = positionOf(trader!.publicKey)

    expect(tokenAmount(setup.svm, setup.accounts.quoteVault) - vaultBefore).toBe(amountIn)
    expect(tokenAmount(setup.svm, quoteAtaOf(trader!.publicKey))).toBe(0n)
    expect(position?.basis).toBe(event.netIntoCurve - DUST_PER_BUY)
    expect(position?.basis).toBe(event.basis)
    expect(position?.tokens).toBe(event.tokensOut)
    expect(tokenAmount(setup.svm, baseAtaOf(trader!.publicKey))).toBe(event.tokensOut)
    expect(marketState().totalBasis).toBe(position?.basis)
  })

  it('a partial sell refunds exactly refund_for(basis part) into the wSOL ATA', () => {
    const [seller, other] = setup.traders
    buy(other!, threshold / PRICE_RAISE_BUY_DIVISOR) // raises the price, so the sell parks a real surplus in the buffer
    const before = positionOf(seller!.publicKey)!
    const tokens = before.tokens / 2n
    const basisPart = (before.basis * tokens) / before.tokens
    const expected = refundForBasis(basisPart, marketState().feeNumerator)
    const quoteBefore = tokenAmount(setup.svm, quoteAtaOf(seller!.publicKey))

    const event = sell(seller!, tokens, false)

    expect(expected).toBe(basisPart - ceilDiv(basisPart * marketState().feeNumerator, FEE_DENOMINATOR) - 2n)
    expect(tokenAmount(setup.svm, quoteAtaOf(seller!.publicKey)) - quoteBefore).toBe(expected)
    expect(event.refund).toBe(expected)
    expect(event.basisPart).toBe(basisPart)
    expect(event.proceeds > event.refund).toBe(true)
    const after = positionOf(seller!.publicKey)
    expect(after?.tokens).toBe(before.tokens - tokens)
    expect(after?.basis).toBe(before.basis - basisPart)
  })

  it('a sell with unwrapSol closes the wSOL ATA and returns the refund as SOL', () => {
    const trader = setup.traders[1]!
    const position = positionOf(trader.publicKey)!
    const tokens = position.tokens / 3n
    const quoteAta = quoteAtaOf(trader.publicKey)
    const ataLamportsBefore = lamportsOf(quoteAta)
    const lamportsBefore = lamportsOf(trader.publicKey)

    const event = sell(trader, tokens, true)

    expect(event.refund).toBe(refundForBasis((position.basis * tokens) / position.tokens, marketState().feeNumerator))
    expect(setup.svm.getAccount(quoteAta)).toBeNull()
    expect(lamportsOf(trader.publicKey) - lamportsBefore).toBe(ataLamportsBefore + event.refund - LITESVM_SIGNATURE_FEE)
  })

  it('finalize is rejected while the curve is live', () => {
    const { market, pool, bufferVault } = setup.accounts
    const res = setup.send(cranker, [finalizeInstruction({ cluster, market, pool, bufferVault })])
    expect(res.ok).toBe(false)
    expect(res.logs.join('\n')).toMatch(/CurveNotComplete/)
  })

  it('6 traders graduate the curve through the router with no position above 20% of swap_base_amount', () => {
    const chunk = threshold / GRADUATION_CHUNKS
    const holding = (t: Keypair): bigint => positionOf(t.publicKey)?.tokens ?? 0n
    for (let n = 0; n < MAX_GRADUATION_BUYS && !isCurveComplete(setup.svm, setup.accounts.pool); n++) {
      const smallest = setup.traders.reduce((min, t) => (holding(t) < holding(min) ? t : min))
      buy(smallest, chunk)
    }

    const pool = setup.svm.getAccount(setup.accounts.pool)!
    expect(pool.data[POOL_MIGRATION_PROGRESS_OFFSET]).not.toBe(0)
    const holdings = setup.traders.map(holding)
    expect(holdings.filter((h) => h > 0n)).toHaveLength(6)
    holdings.forEach((h) => expect(h <= whaleCap, `position ${h} above cap ${whaleCap}`).toBe(true))
  }, LIFECYCLE_TIMEOUT_MS)

  it('finalize (any signer) snapshots the buffer surplus and the open basis', () => {
    const { market, pool, bufferVault } = setup.accounts
    const buffer = tokenAmount(setup.svm, bufferVault)
    const openBasis = setup.traders.reduce((sum, t) => sum + (positionOf(t.publicKey)?.basis ?? 0n), 0n)
    expect(marketState().totalBasis).toBe(openBasis)

    const event = eventOf(sendOk(cranker, [finalizeInstruction({ cluster, market, pool, bufferVault })]), 'FinalizeEvent')

    const state = marketState()
    expect(state.finalized).toBe(true)
    expect(buffer > 0n).toBe(true)
    expect(state.surplusSnapshot).toBe(buffer)
    expect(state.basisSnapshot).toBe(openBasis)
    expect(event.surplus).toBe(buffer)
  })

  it("claim_surplus by a third-party cranker pays each owner's canonical quote ATA; claims never exceed the snapshot", () => {
    const { surplusSnapshot, basisSnapshot } = marketState()
    const crankerLamports = lamportsOf(cranker.publicKey)
    const shares = setup.traders.map((trader) => {
      const position = positionOf(trader.publicKey)!
      const ownerQuote = quoteAtaOf(trader.publicKey)
      const quoteBefore = tokenAmount(setup.svm, ownerQuote)
      const ownerLamportsBefore = lamportsOf(trader.publicKey)
      const positionRent = lamportsOf(position.address)

      sendOk(cranker, [
        createAssociatedTokenAccountIdempotentInstruction(cranker.publicKey, ownerQuote, trader.publicKey, NATIVE_MINT, TOKEN_PROGRAM_ID),
        claimSurplusInstruction({ cluster, accounts: setup.accounts, cranker: cranker.publicKey, owner: trader.publicKey }),
      ])

      const share = tokenAmount(setup.svm, ownerQuote) - quoteBefore
      expect(share).toBe((surplusSnapshot * position.basis) / basisSnapshot)
      expect(positionOf(trader.publicKey)).toBeNull()
      expect(lamportsOf(trader.publicKey)).toBe(ownerLamportsBefore + positionRent)
      return share
    })

    const paid = shares.reduce((a, b) => a + b, 0n)
    expect(paid > 0n).toBe(true)
    expect(paid <= surplusSnapshot).toBe(true)
    expect(marketState().surplusClaimed).toBe(paid)
    expect(tokenAmount(setup.svm, setup.accounts.bufferVault)).toBe(surplusSnapshot - paid)
    expect(setup.svm.getAccount(quoteAtaOf(cranker.publicKey))).toBeNull()
    expect(lamportsOf(cranker.publicKey) < crankerLamports).toBe(true)
  })
})
