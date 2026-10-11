/**
 * SDK-20: sellInstructions creates the user's quote ATA idempotently, so an at-cost exit works after an earlier
 * unwrap closed the wSOL ATA, and when the canonical quote ATA never existed. Also pins the quote token program
 * check and the native-quote rule (NATIVE_MINT under SPL Token only).
 */
import { Buffer } from 'buffer'
import { Keypair, PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js'
import {
  ACCOUNT_SIZE,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createInitializeAccount3Instruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  autoExitInstruction,
  basisForExit,
  buyInstructions,
  decodeMarket,
  decodePosition,
  findBufferPda,
  findMarketPda,
  findPositionPda,
  getClusterConfig,
  parseRouterEvents,
  refundFor,
  sellInstructions,
} from '../src/index.js'
import type { MarketAccounts, PositionAccount, SellEvent } from '../src/index.js'
import { CONFIG_MIGRATION_QUOTE_THRESHOLD_OFFSET, readU64, setupMarket, tokenAmount, type MarketSetup } from './helpers/litesvm.js'

const cluster = getClusterConfig('localnet')

function marketAccounts(quoteMint: PublicKey, quoteTokenProgram: PublicKey): MarketAccounts {
  const pool = Keypair.generate().publicKey
  const market = findMarketPda(pool, cluster.routerProgramId)
  return {
    market, pool, config: Keypair.generate().publicKey, baseMint: Keypair.generate().publicKey, quoteMint,
    baseVault: Keypair.generate().publicKey, quoteVault: Keypair.generate().publicKey,
    bufferVault: findBufferPda(market, cluster.routerProgramId), quoteTokenProgram,
  }
}

const isRouterIx = (ix: TransactionInstruction): boolean => ix.programId.equals(cluster.routerProgramId)

describe('sellInstructions shape', () => {
  const user = Keypair.generate().publicKey

  it('native quote: idempotent wSOL ATA creation, router sell, then closeAccount only when unwrapping', () => {
    const accounts = marketAccounts(NATIVE_MINT, TOKEN_PROGRAM_ID)
    const quoteAta = getAssociatedTokenAddressSync(NATIVE_MINT, user, false, TOKEN_PROGRAM_ID)
    const createAta = createAssociatedTokenAccountIdempotentInstruction(user, quoteAta, user, NATIVE_MINT, TOKEN_PROGRAM_ID)

    const kept = sellInstructions({ cluster, accounts, user, tokens: 10n, unwrapSol: false })
    expect(kept).toHaveLength(2)
    expect(kept[0]).toEqual(createAta)
    expect(isRouterIx(kept[1]!)).toBe(true)

    const unwrapped = sellInstructions({ cluster, accounts, user, tokens: 10n, unwrapSol: true })
    expect(unwrapped).toHaveLength(3)
    expect(unwrapped[0]).toEqual(createAta)
    expect(unwrapped[1]).toEqual(kept[1])
    expect(unwrapped[2]).toEqual(createCloseAccountInstruction(quoteAta, user, user, [], TOKEN_PROGRAM_ID))
  })

  it('Token-2022 quote: the ATA is created under the quote token program and never closed', () => {
    const accounts = marketAccounts(Keypair.generate().publicKey, TOKEN_2022_PROGRAM_ID)
    const quoteAta = getAssociatedTokenAddressSync(accounts.quoteMint, user, false, TOKEN_2022_PROGRAM_ID)
    const ixs = sellInstructions({ cluster, accounts, user, tokens: 10n, unwrapSol: true })
    expect(ixs).toHaveLength(2)
    expect(ixs[0]).toEqual(createAssociatedTokenAccountIdempotentInstruction(user, quoteAta, user, accounts.quoteMint, TOKEN_2022_PROGRAM_ID))
    expect(isRouterIx(ixs[1]!)).toBe(true)
  })

  it('NATIVE_MINT under Token-2022 is not treated as native: no wrap on buy, no close on sell', () => {
    const accounts = marketAccounts(NATIVE_MINT, TOKEN_2022_PROGRAM_ID)
    const quoteAta = getAssociatedTokenAddressSync(NATIVE_MINT, user, false, TOKEN_2022_PROGRAM_ID)

    const sell = sellInstructions({ cluster, accounts, user, tokens: 10n, unwrapSol: true })
    expect(sell).toHaveLength(2)
    expect(sell[0]).toEqual(createAssociatedTokenAccountIdempotentInstruction(user, quoteAta, user, NATIVE_MINT, TOKEN_2022_PROGRAM_ID))
    expect(isRouterIx(sell[1]!)).toBe(true)

    const buy = buyInstructions({ cluster, accounts, user, amountIn: 5_000n, minOut: 0n })
    expect(buy).toHaveLength(3)
    expect(buy.some((ix) => ix.programId.equals(SystemProgram.programId))).toBe(false)
    expect(isRouterIx(buy[2]!)).toBe(true)
  })

  it.each([
    ['sellInstructions', (accounts: MarketAccounts) => sellInstructions({ cluster, accounts, user, tokens: 1n, unwrapSol: true })],
    ['buyInstructions', (accounts: MarketAccounts) => buyInstructions({ cluster, accounts, user, amountIn: 1n, minOut: 0n })],
    ['autoExitInstruction', (accounts: MarketAccounts) => autoExitInstruction({ cluster, accounts, cranker: user, owner: user })],
  ] as const)('%s rejects a quoteTokenProgram that is neither SPL Token nor Token-2022 with a TypeError', (_, build) => {
    const accounts = marketAccounts(NATIVE_MINT, Keypair.generate().publicKey)
    expect(() => build(accounts)).toThrow(TypeError)
    expect(() => build(accounts)).toThrow(/quoteTokenProgram/)
  })
})

/* ---------- LiteSVM: repeated exits ---------- */

/** Buy sizes as fractions of the migration threshold; small enough to stay under the Anti-Whale cap. */
const FIRST_BUY_DIVISOR = 60n
const PRICE_RAISE_BUY_DIVISOR = 30n
const LITESVM_SIGNATURE_FEE = 5_000n
const SETUP_TIMEOUT_MS = 120_000

describe('sell after the quote ATA is gone (LiteSVM, wSOL quote)', () => {
  let setup: MarketSetup
  let threshold: bigint

  const sendOk = (payer: Keypair, ixs: readonly TransactionInstruction[], signers: readonly Keypair[] = []): readonly string[] => {
    const res = setup.send(payer, ixs, signers)
    if (!res.ok) throw new Error(`transaction failed: ${res.error}\n${res.logs.slice(-6).join('\n')}`)
    return res.logs
  }
  const sellEventOf = (logs: readonly string[]): SellEvent => {
    const event = parseRouterEvents(logs, cluster.routerProgramId).find((e) => e.name === 'SellEvent')
    if (event === undefined) throw new Error(`no SellEvent in logs:\n${logs.join('\n')}`)
    return event as SellEvent
  }
  const feeNumerator = (): bigint => {
    const account = setup.svm.getAccount(setup.accounts.market)
    if (account === null) throw new Error('market account missing')
    return decodeMarket(setup.accounts.market, Buffer.from(account.data)).feeNumerator
  }
  const positionOf = (owner: PublicKey): PositionAccount => {
    const address = findPositionPda(setup.accounts.market, owner, cluster.routerProgramId)
    const account = setup.svm.getAccount(address)
    if (account === null) throw new Error(`position of ${owner.toBase58()} missing`)
    return decodePosition(address, Buffer.from(account.data))
  }
  const expectedRefund = (position: PositionAccount, tokens: bigint): bigint => {
    const basisPart = basisForExit(position.tokens, position.basis, tokens)
    if (basisPart === null) throw new Error(`cannot exit ${tokens} of ${position.tokens}`)
    return refundFor(basisPart, feeNumerator())
  }
  const wsolAtaOf = (owner: PublicKey): PublicKey => getAssociatedTokenAddressSync(NATIVE_MINT, owner, false, TOKEN_PROGRAM_ID)
  const lamportsOf = (address: PublicKey): bigint => setup.svm.getBalance(address) ?? 0n
  const buy = (trader: Keypair, amountIn: bigint): void => {
    sendOk(trader, buyInstructions({ cluster, accounts: setup.accounts, user: trader.publicKey, amountIn, minOut: 1n }))
  }
  const sell = (trader: Keypair, tokens: bigint, unwrapSol: boolean): SellEvent =>
    sellEventOf(sendOk(trader, sellInstructions({ cluster, accounts: setup.accounts, user: trader.publicKey, tokens, unwrapSol })))

  /**
   * Buys through a keypair wSOL token account instead of the canonical ATA (the router accepts any quote account
   * the user owns), so the user holds a position while their canonical wSOL ATA has never existed.
   */
  const buyWithoutCanonicalAta = (trader: Keypair, amountIn: bigint): void => {
    const owner = trader.publicKey
    const canonical = wsolAtaOf(owner)
    const source = Keypair.generate()
    const rent = setup.svm.minimumBalanceForRentExemption(BigInt(ACCOUNT_SIZE))
    const sdkBuy = buyInstructions({ cluster, accounts: setup.accounts, user: owner, amountIn, minOut: 1n })
    const routerBuy = sdkBuy[sdkBuy.length - 1]!
    const createBaseAta = sdkBuy.find((ix) =>
      ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID) && (ix.keys[3]?.pubkey.equals(setup.accounts.baseMint) ?? false))
    if (createBaseAta === undefined) throw new Error('buyInstructions returned no base ATA creation')
    const buyFromSource = new TransactionInstruction({
      programId: routerBuy.programId,
      data: routerBuy.data,
      keys: routerBuy.keys.map((k) => (k.pubkey.equals(canonical) ? { ...k, pubkey: source.publicKey } : k)),
    })
    sendOk(trader, [
      SystemProgram.createAccount({
        fromPubkey: owner, newAccountPubkey: source.publicKey, lamports: Number(rent + amountIn), space: ACCOUNT_SIZE, programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeAccount3Instruction(source.publicKey, NATIVE_MINT, owner, TOKEN_PROGRAM_ID),
      createBaseAta,
      buyFromSource,
    ], [source])
  }

  beforeAll(async () => {
    setup = await setupMarket({ traders: 3 })
    threshold = readU64(setup.svm, setup.accounts.config, CONFIG_MIGRATION_QUOTE_THRESHOLD_OFFSET)
  }, SETUP_TIMEOUT_MS)

  it('partial exit with unwrapSol closes the wSOL ATA and pays SOL; the next unwrap exit of the rest still succeeds at cost', () => {
    const [trader, bystander] = setup.traders
    const quoteAta = wsolAtaOf(trader!.publicKey)
    buy(trader!, threshold / FIRST_BUY_DIVISOR)
    buy(bystander!, threshold / PRICE_RAISE_BUY_DIVISOR) // raises the price, so each exit parks a real surplus

    // First exit: half, unwrapped. The ATA exists from the buy and is closed afterwards.
    const start = positionOf(trader!.publicKey)
    const half = start.tokens / 2n
    const ataLamports = lamportsOf(quoteAta)
    const lamportsBeforeFirst = lamportsOf(trader!.publicKey)
    const first = sell(trader!, half, true)

    expect(first.refund).toBe(expectedRefund(start, half))
    expect(first.refund > 0n).toBe(true)
    expect(setup.svm.getAccount(quoteAta)).toBeNull()
    expect(lamportsOf(trader!.publicKey) - lamportsBeforeFirst).toBe(ataLamports + first.refund - LITESVM_SIGNATURE_FEE)

    // Second exit: the rest, unwrapped, with no wSOL ATA on chain. The ATA rent is paid and returned in the same tx.
    const rest = positionOf(trader!.publicKey)
    expect(rest.tokens).toBe(start.tokens - half)
    const lamportsBeforeSecond = lamportsOf(trader!.publicKey)
    const second = sell(trader!, rest.tokens, true)

    expect(second.basisPart).toBe(rest.basis)
    expect(second.refund).toBe(refundFor(rest.basis, feeNumerator()))
    expect(second.refund > 0n).toBe(true)
    expect(setup.svm.getAccount(quoteAta)).toBeNull()
    expect(lamportsOf(trader!.publicKey) - lamportsBeforeSecond).toBe(second.refund - LITESVM_SIGNATURE_FEE)
    expect(positionOf(trader!.publicKey).tokens).toBe(0n)
    expect(positionOf(trader!.publicKey).basis).toBe(0n)
  })

  it('a sell succeeds when the canonical quote ATA never existed; the refund lands in a freshly created ATA', () => {
    const trader = setup.traders[2]!
    const quoteAta = wsolAtaOf(trader.publicKey)
    buyWithoutCanonicalAta(trader, threshold / FIRST_BUY_DIVISOR)
    expect(setup.svm.getAccount(quoteAta)).toBeNull()

    const position = positionOf(trader.publicKey)
    expect(position.tokens > 0n).toBe(true)
    const event = sell(trader, position.tokens, false)

    expect(event.refund).toBe(refundFor(position.basis, feeNumerator()))
    expect(event.refund > 0n).toBe(true)
    expect(tokenAmount(setup.svm, quoteAta)).toBe(event.refund)
    expect(positionOf(trader.publicKey).tokens).toBe(0n)
  })
})
