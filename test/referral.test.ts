/**
 * SDK-16: buyInstructions takes an optional referrer (Native Referral, ONC-05 / ONC-13). The user idempotently creates
 * the referrer's canonical quote ATA right before the router buy, and that ATA follows the three hook accounts as the
 * buy's 4th remaining account. DBC pays the referral cut out of its protocol fee, so the buyer's cost and basis do not
 * change. A self-referral is ignored.
 */
import { Buffer } from 'buffer'
import { Keypair, PublicKey, type AccountMeta, type TransactionInstruction } from '@solana/web3.js'
import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  buyInstructions,
  decodePosition,
  findBufferPda,
  findMarketPda,
  findPositionPda,
  getClusterConfig,
  parseRouterEvents,
} from '../src/index.js'
import type { BuyEvent, MarketAccounts, PositionAccount } from '../src/index.js'
import { CONFIG_MIGRATION_QUOTE_THRESHOLD_OFFSET, LITESVM_SKIP_REASON, litesvmSuiteTitle, readU64, setupMarket, tokenAmount, type MarketSetup } from './helpers/litesvm.js'

const cluster = getClusterConfig('localnet')
/** Router buy accounts without a referrer: 6 router + 12 DBC swap accounts, then 3 hook remaining accounts. */
const ROUTER_BUY_KEY_COUNT = 21

function marketAccounts(quoteMint: PublicKey, quoteTokenProgram: PublicKey): MarketAccounts {
  const pool = Keypair.generate().publicKey
  const market = findMarketPda(pool, cluster.routerProgramId)
  return {
    market, pool, config: Keypair.generate().publicKey, baseMint: Keypair.generate().publicKey, quoteMint,
    baseVault: Keypair.generate().publicKey, quoteVault: Keypair.generate().publicKey,
    bufferVault: findBufferPda(market, cluster.routerProgramId), quoteTokenProgram,
  }
}

const routerIxOf = (ixs: readonly TransactionInstruction[]): TransactionInstruction => {
  const router = ixs[ixs.length - 1]
  if (router === undefined || !router.programId.equals(cluster.routerProgramId)) throw new Error('the last instruction is not the router buy')
  return router
}
const metaOf = (k: AccountMeta) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })

/* ---------- offline: instruction shape ---------- */

describe('buyInstructions with a referrer (instruction shape)', () => {
  const user = Keypair.generate().publicKey
  const referrer = Keypair.generate().publicKey

  it.each([
    ['native SOL (SPL Token)', NATIVE_MINT, TOKEN_PROGRAM_ID],
    ['SPL Token', Keypair.generate().publicKey, TOKEN_PROGRAM_ID],
    ['Token-2022', Keypair.generate().publicKey, TOKEN_2022_PROGRAM_ID],
  ] as const)('%s quote: creates the referrer quote ATA (user pays) right before the buy and appends it as the 4th remaining account', (_, quoteMint, quoteTokenProgram) => {
    // Arrange
    const accounts = marketAccounts(quoteMint, quoteTokenProgram)
    const referrerAta = getAssociatedTokenAddressSync(quoteMint, referrer, false, quoteTokenProgram)
    const plain = buyInstructions({ cluster, accounts, user, amountIn: 5_000n, minOut: 1n })

    // Act
    const referred = buyInstructions({ cluster, accounts, user, amountIn: 5_000n, minOut: 1n, referrer })

    // Assert: every existing instruction keeps its place; the referrer ATA creation sits between them and the buy.
    expect(referred).toHaveLength(plain.length + 1)
    expect(referred.slice(0, plain.length - 1)).toEqual(plain.slice(0, -1))
    expect(referred[plain.length - 1]).toEqual(
      createAssociatedTokenAccountIdempotentInstruction(user, referrerAta, referrer, quoteMint, quoteTokenProgram))
    const plainBuy = routerIxOf(plain)
    const referredBuy = routerIxOf(referred)
    expect(referredBuy.data.equals(plainBuy.data)).toBe(true)
    expect(plainBuy.keys).toHaveLength(ROUTER_BUY_KEY_COUNT)
    expect(referredBuy.keys.map(metaOf)).toEqual([
      ...plainBuy.keys.map(metaOf),
      { pubkey: referrerAta.toBase58(), isSigner: false, isWritable: true },
    ])
  })

  it('a self-referral (referrer == user) is ignored: no ATA creation and no 4th remaining account', () => {
    const accounts = marketAccounts(NATIVE_MINT, TOKEN_PROGRAM_ID)
    const plain = buyInstructions({ cluster, accounts, user, amountIn: 5_000n, minOut: 1n })
    const self = buyInstructions({ cluster, accounts, user, amountIn: 5_000n, minOut: 1n, referrer: new PublicKey(user.toBytes()) })
    expect(self).toEqual(plain)
  })

  it('an explicit undefined referrer builds the plain buy', () => {
    const accounts = marketAccounts(NATIVE_MINT, TOKEN_PROGRAM_ID)
    const plain = buyInstructions({ cluster, accounts, user, amountIn: 5_000n, minOut: 1n })
    expect(buyInstructions({ cluster, accounts, user, amountIn: 5_000n, minOut: 1n, referrer: undefined })).toEqual(plain)
  })

  it('an off-curve referrer (a PDA wallet) is accepted: its quote ATA is derived with allowOwnerOffCurve', () => {
    const accounts = marketAccounts(NATIVE_MINT, TOKEN_PROGRAM_ID)
    const [pdaReferrer] = PublicKey.findProgramAddressSync([Buffer.from('referrer')], cluster.routerProgramId)
    expect(PublicKey.isOnCurve(pdaReferrer.toBytes())).toBe(false)
    const referrerAta = getAssociatedTokenAddressSync(NATIVE_MINT, pdaReferrer, true, TOKEN_PROGRAM_ID)

    const ixs = buyInstructions({ cluster, accounts, user, amountIn: 5_000n, minOut: 1n, referrer: pdaReferrer })

    const keys = routerIxOf(ixs).keys
    expect(keys[keys.length - 1]).toEqual({ pubkey: referrerAta, isSigner: false, isWritable: true })
    expect(ixs[ixs.length - 2]).toEqual(
      createAssociatedTokenAccountIdempotentInstruction(user, referrerAta, pdaReferrer, NATIVE_MINT, TOKEN_PROGRAM_ID))
  })

  it.each([
    ['null', null],
    ['a base58 string', Keypair.generate().publicKey.toBase58()],
    ['a 31-byte key-like object', { toBytes: () => new Uint8Array(31), toBase58: () => 'short' }],
  ])('rejects a referrer that is %s with a TypeError naming the field', (_, referrer) => {
    const accounts = marketAccounts(NATIVE_MINT, TOKEN_PROGRAM_ID)
    const build = () => buyInstructions({ cluster, accounts, user, amountIn: 5_000n, minOut: 1n, referrer: referrer as unknown as PublicKey })
    expect(build).toThrow(TypeError)
    expect(build).toThrow(/referrer/)
  })
})

/* ---------- LiteSVM: the referral cut ---------- */

/** Small enough to stay under the Anti-Whale cap; large enough that DBC's referral cut is above zero. */
const BUY_DIVISOR = 60n
const SETUP_TIMEOUT_MS = 180_000

describe.skipIf(LITESVM_SKIP_REASON !== null)(litesvmSuiteTitle('referral buys on LiteSVM (wSOL quote, capped router)'), () => {
  /** Market A: the buyer names a referrer. Market B: an identical fresh market, the same buy without one. */
  let a: MarketSetup
  let b: MarketSetup
  let amountIn: bigint
  const referrer = Keypair.generate().publicKey // an unfunded wallet: the buyer pays its ATA rent
  const referrerAta = getAssociatedTokenAddressSync(NATIVE_MINT, referrer, false, TOKEN_PROGRAM_ID)
  const wsolAtaOf = (owner: PublicKey): PublicKey => getAssociatedTokenAddressSync(NATIVE_MINT, owner, false, TOKEN_PROGRAM_ID)

  const buyOn = (setup: MarketSetup, trader: Keypair, buyReferrer?: PublicKey): BuyEvent => {
    const ixs = buyInstructions({ cluster, accounts: setup.accounts, user: trader.publicKey, amountIn, minOut: 1n, referrer: buyReferrer })
    const res = setup.send(trader, ixs)
    if (!res.ok) throw new Error(`buy failed: ${res.error}\n${res.logs.slice(-6).join('\n')}`)
    const event = parseRouterEvents(res.logs, cluster.routerProgramId).find((e) => e.name === 'BuyEvent')
    if (event === undefined) throw new Error(`no BuyEvent in logs:\n${res.logs.join('\n')}`)
    return event as BuyEvent
  }
  const positionOf = (setup: MarketSetup, owner: PublicKey): PositionAccount => {
    const address = findPositionPda(setup.accounts.market, owner, cluster.routerProgramId)
    const account = setup.svm.getAccount(address)
    if (account === null) throw new Error(`position of ${owner.toBase58()} missing`)
    return decodePosition(address, Buffer.from(account.data))
  }
  const quoteVaultOf = (setup: MarketSetup): bigint => tokenAmount(setup.svm, setup.accounts.quoteVault)

  beforeAll(async () => {
    a = await setupMarket({ traders: 1 })
    b = await setupMarket({ traders: 2 })
    amountIn = readU64(a.svm, a.accounts.config, CONFIG_MIGRATION_QUOTE_THRESHOLD_OFFSET) / BUY_DIVISOR
  }, SETUP_TIMEOUT_MS)

  it("a buy with a referrer increases the referrer's quote ATA balance; the cut leaves the pool's quote vault", () => {
    // Arrange
    const [buyer] = a.traders
    expect(a.svm.getAccount(referrerAta)).toBeNull()
    const vaultBefore = quoteVaultOf(a)

    // Act
    const event = buyOn(a, buyer!, referrer)

    // Assert
    const gain = tokenAmount(a.svm, referrerAta)
    expect(gain > 0n).toBe(true)
    expect(quoteVaultOf(a) - vaultBefore).toBe(amountIn - gain)
    expect(tokenAmount(a.svm, wsolAtaOf(buyer!.publicKey))).toBe(0n)
    expect(positionOf(a, buyer!.publicKey).basis).toBe(event.basis)
  })

  it('the same buy without a referrer on an identical fresh market records the same basis and tokens', () => {
    // Arrange
    const [buyer] = b.traders
    const referred = positionOf(a, a.traders[0]!.publicKey)
    const vaultBefore = quoteVaultOf(b)

    // Act
    const event = buyOn(b, buyer!)

    // Assert
    const plain = positionOf(b, buyer!.publicKey)
    expect(plain.basis > 0n).toBe(true)
    expect(plain.basis).toBe(referred.basis)
    expect(plain.tokens).toBe(referred.tokens)
    expect(event.basis).toBe(referred.basis)
    expect(quoteVaultOf(b) - vaultBefore).toBe(amountIn)
  })

  it('a self-referral adds no 4th account and pays the buyer no cut', () => {
    // Arrange
    const buyer = b.traders[1]!
    const plainIxs = buyInstructions({ cluster, accounts: b.accounts, user: buyer.publicKey, amountIn, minOut: 1n })
    const selfIxs = buyInstructions({ cluster, accounts: b.accounts, user: buyer.publicKey, amountIn, minOut: 1n, referrer: buyer.publicKey })
    const vaultBefore = quoteVaultOf(b)

    // Act
    const event = buyOn(b, buyer, buyer.publicKey)

    // Assert
    expect(selfIxs).toEqual(plainIxs)
    const selfKeys = routerIxOf(selfIxs).keys
    expect(selfKeys).toHaveLength(ROUTER_BUY_KEY_COUNT)
    expect(selfKeys[selfKeys.length - 1]?.pubkey.equals(cluster.hookProgramId)).toBe(true) // the hook program ends the list
    expect(tokenAmount(b.svm, wsolAtaOf(buyer.publicKey))).toBe(0n)
    expect(quoteVaultOf(b) - vaultBefore).toBe(amountIn)
    expect(positionOf(b, buyer.publicKey).basis).toBe(event.basis)
  })
})
