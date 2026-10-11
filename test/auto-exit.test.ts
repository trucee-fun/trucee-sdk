/**
 * SDK-12: Auto-Exit builders (set_auto_exit + token delegate, auto_exit) and events (AutoExitSetEvent,
 * AutoExitEvent). Unit tests pin data layouts and account orders (zpvp_router SetAutoExit / AutoExit, ONC-11/12);
 * the LiteSVM suite enables, disables and cranks Auto-Exit on one wSOL market with a warped clock.
 */
import { createHash } from 'node:crypto'
import { Buffer } from 'buffer'
import { Keypair, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, SystemProgram, type AccountMeta, type TransactionInstruction } from '@solana/web3.js'
import {
  AccountLayout,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createApproveCheckedInstruction,
  createRevokeInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import { deriveDbcEventAuthority, deriveDbcPoolAuthority } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { Clock, type LiteSVM } from 'litesvm'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  EVENT_DISCRIMINATORS,
  FEE_DENOMINATOR,
  HAIRCUT_PER_EXIT,
  ROUTER_PROGRAM_ID,
  autoExitInstruction,
  buyInstructions,
  decodeMarket,
  decodePosition,
  findBufferPda,
  findExtraAccountMetasPda,
  findMarketPda,
  findPositionPda,
  getClusterConfig,
  parseRouterEvents,
  setAutoExitInstructions,
} from '../src/index.js'
import type { AutoExitEvent, AutoExitSetEvent, MarketAccounts, PositionAccount, RouterEvent } from '../src/index.js'
import { readU64, setupMarket, tokenAmount, CONFIG_MIGRATION_QUOTE_THRESHOLD_OFFSET, type MarketSetup } from './helpers/litesvm.js'

const cluster = getClusterConfig('localnet')
const U64_MAX = 2n ** 64n - 1n
const I64_MAX = 2n ** 63n - 1n
const BASE_DECIMALS = 6

const anchorDiscriminator = (namespace: 'global' | 'event', name: string): Buffer =>
  Buffer.from(createHash('sha256').update(`${namespace}:${name}`).digest().subarray(0, 8))
const i64le = (value: bigint): Buffer => {
  const out = Buffer.alloc(8)
  out.writeBigInt64LE(value)
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

const baseAtaOf = (a: MarketAccounts, owner: PublicKey) => getAssociatedTokenAddressSync(a.baseMint, owner, false, TOKEN_2022_PROGRAM_ID)
const quoteAtaOf = (a: MarketAccounts, owner: PublicKey) => getAssociatedTokenAddressSync(a.quoteMint, owner, false, a.quoteTokenProgram)

/** SetAutoExit: owner (signer), market, position (w). */
const expectedSetKeys = (a: MarketAccounts, owner: PublicKey) =>
  [meta(owner, false, true), meta(a.market), meta(findPositionPda(a.market, owner, cluster.routerProgramId), true)]

describe('instruction data', () => {
  const accounts = marketAccounts(NATIVE_MINT, TOKEN_PROGRAM_ID)
  const owner = Keypair.generate().publicKey

  it('pins the set_auto_exit and auto_exit discriminators', () => {
    expect([...anchorDiscriminator('global', 'set_auto_exit')]).toEqual([60, 166, 18, 156, 35, 166, 156, 226])
    expect([...anchorDiscriminator('global', 'auto_exit')]).toEqual([69, 201, 207, 131, 57, 141, 243, 167])
  })

  it.each([1n, 1_800_000_000n, I64_MAX])('set_auto_exit = sha256("global:set_auto_exit")[..8] | deadline i64 (%s)', (deadline) => {
    const ixs = setAutoExitInstructions({ cluster, accounts, owner, deadline })
    expect(dataOf(ixs[1]!)).toBe(Buffer.concat([anchorDiscriminator('global', 'set_auto_exit'), i64le(deadline)]).toString('hex'))
  })

  it('set_auto_exit(0) when disabling', () => {
    const [set] = setAutoExitInstructions({ cluster, accounts, owner, deadline: 0n })
    expect(dataOf(set!)).toBe(Buffer.concat([anchorDiscriminator('global', 'set_auto_exit'), i64le(0n)]).toString('hex'))
  })

  it('auto_exit = sha256("global:auto_exit")[..8] and nothing else', () => {
    const ix = autoExitInstruction({ cluster, accounts, cranker: owner, owner })
    expect(dataOf(ix)).toBe(anchorDiscriminator('global', 'auto_exit').toString('hex'))
  })
})

describe('account orders', () => {
  const owner = Keypair.generate().publicKey

  it("enabling: approveChecked(owner's base ATA -> market PDA, u64::MAX, 6 decimals, Token-2022), then set_auto_exit", () => {
    const accounts = marketAccounts(NATIVE_MINT, TOKEN_PROGRAM_ID)
    const ixs = setAutoExitInstructions({ cluster, accounts, owner, deadline: 1_800_000_000n })
    expect(ixs).toHaveLength(2)
    expect(ixs[0]).toEqual(createApproveCheckedInstruction(
      baseAtaOf(accounts, owner), accounts.baseMint, accounts.market, owner, U64_MAX, BASE_DECIMALS, [], TOKEN_2022_PROGRAM_ID,
    ))
    expect(ixs[1]!.programId.equals(cluster.routerProgramId)).toBe(true)
    expect(keysOf(ixs[1]!)).toEqual(expectedSetKeys(accounts, owner))
  })

  it("disabling: set_auto_exit(0), then revoke the owner's base ATA delegate", () => {
    const accounts = marketAccounts(Keypair.generate().publicKey, TOKEN_2022_PROGRAM_ID)
    const ixs = setAutoExitInstructions({ cluster, accounts, owner, deadline: 0n })
    expect(ixs).toHaveLength(2)
    expect(ixs[0]!.programId.equals(cluster.routerProgramId)).toBe(true)
    expect(keysOf(ixs[0]!)).toEqual(expectedSetKeys(accounts, owner))
    expect(ixs[1]).toEqual(createRevokeInstruction(baseAtaOf(accounts, owner), owner, [], TOKEN_2022_PROGRAM_ID))
  })

  it.each([
    ['wSOL', NATIVE_MINT, TOKEN_PROGRAM_ID],
    ['Token-2022 quote', Keypair.generate().publicKey, TOKEN_2022_PROGRAM_ID],
  ] as const)("autoExitInstruction (%s): cranker signs; owner's canonical ATAs; DBC swap accounts; hook remaining accounts", (_, quoteMint, quoteProgram) => {
    const accounts = marketAccounts(quoteMint, quoteProgram)
    const cranker = Keypair.generate().publicKey
    const ix = autoExitInstruction({ cluster, accounts, cranker, owner })
    expect(ix.programId.equals(cluster.routerProgramId)).toBe(true)
    expect(keysOf(ix)).toEqual([
      meta(cranker, false, true), meta(owner), meta(accounts.market, true),
      meta(findPositionPda(accounts.market, owner, cluster.routerProgramId), true),
      meta(quoteAtaOf(accounts, owner), true), meta(baseAtaOf(accounts, owner), true), meta(accounts.bufferVault, true),
      meta(deriveDbcPoolAuthority()), meta(accounts.config), meta(accounts.pool, true), meta(accounts.baseVault, true),
      meta(accounts.quoteVault, true), meta(accounts.baseMint, true), meta(quoteMint), meta(TOKEN_2022_PROGRAM_ID), meta(quoteProgram),
      meta(deriveDbcEventAuthority()), meta(cluster.dbcProgramId), meta(SystemProgram.programId),
      meta(findExtraAccountMetasPda(accounts.baseMint, cluster.hookProgramId)), meta(SYSVAR_INSTRUCTIONS_PUBKEY), meta(cluster.hookProgramId),
    ])
  })
})

describe('input validation', () => {
  const accounts = marketAccounts(NATIVE_MINT, TOKEN_PROGRAM_ID)
  const owner = Keypair.generate().publicKey

  const badDeadlines: Array<[label: string, deadline: unknown, error: typeof RangeError | typeof TypeError]> = [
    ['a negative deadline', -1n, RangeError],
    ['a deadline above i64::MAX', I64_MAX + 1n, RangeError],
    ['a number deadline (unix seconds are bigint)', 1_800_000_000, TypeError],
    ['a missing deadline', undefined, TypeError],
  ]
  it.each(badDeadlines)('setAutoExitInstructions rejects %s', (_, deadline, error) => {
    expect(() => setAutoExitInstructions({ cluster, accounts, owner, deadline: deadline as bigint })).toThrow(error)
    expect(() => setAutoExitInstructions({ cluster, accounts, owner, deadline: deadline as bigint })).toThrow(/deadline/)
  })

  it('never approves a delegate other than the market PDA of accounts.pool', () => {
    const foreign = { ...accounts, market: Keypair.generate().publicKey }
    expect(() => setAutoExitInstructions({ cluster, accounts: foreign, owner, deadline: 1n })).toThrow(/market/)
    expect(() => setAutoExitInstructions({ cluster, accounts: foreign, owner, deadline: 0n })).toThrow(/market/)
  })

  it('rejects missing or non-PublicKey keys with the field name', () => {
    expect(() => setAutoExitInstructions({ cluster, accounts, owner: 'me' as unknown as PublicKey, deadline: 1n })).toThrow(/owner/)
    expect(() => setAutoExitInstructions(null as unknown as Parameters<typeof setAutoExitInstructions>[0])).toThrow(TypeError)
    expect(() => autoExitInstruction({ cluster, accounts, cranker: undefined as unknown as PublicKey, owner })).toThrow(/cranker/)
    expect(() => autoExitInstruction({ cluster, accounts, cranker: owner, owner: null as unknown as PublicKey })).toThrow(/owner/)
    const noBuffer = { ...accounts, bufferVault: undefined } as unknown as MarketAccounts
    expect(() => autoExitInstruction({ cluster, accounts: noBuffer, cranker: owner, owner })).toThrow(/bufferVault/)
  })
})

/* ---------- events ---------- */

const ROUTER = ROUTER_PROGRAM_ID.toBase58()
const routerIx = (...body: string[]): string[] =>
  [`Program ${ROUTER} invoke [1]`, ...body, `Program ${ROUTER} consumed 1 of 200000 compute units`, `Program ${ROUTER} success`]
const dataLine = (payload: Buffer): string => `Program data: ${payload.toString('base64')}`
const key = (pubkey: PublicKey): Buffer => Buffer.from(pubkey.toBytes())
const comparable = (events: readonly RouterEvent[]): unknown[] =>
  events.map((event) => Object.fromEntries(
    Object.entries(event).map(([field, value]) => [field, value instanceof PublicKey ? value.toBase58() : value]),
  ))

describe('Auto-Exit events', () => {
  const market = Keypair.generate().publicKey
  const user = Keypair.generate().publicKey
  const cranker = Keypair.generate().publicKey
  const setPayload = (deadline: bigint): Buffer =>
    Buffer.concat([anchorDiscriminator('event', 'AutoExitSetEvent'), key(market), key(user), i64le(deadline)])
  const exitPayload = Buffer.concat([anchorDiscriminator('event', 'AutoExitEvent'), key(market), key(user), key(cranker)])

  it('pins the event discriminators: sha256("event:<Name>")[..8]', () => {
    expect([...EVENT_DISCRIMINATORS.AutoExitSetEvent]).toEqual([57, 162, 173, 84, 134, 215, 83, 159])
    expect([...EVENT_DISCRIMINATORS.AutoExitEvent]).toEqual([53, 28, 54, 192, 105, 98, 182, 95])
    expect(EVENT_DISCRIMINATORS.AutoExitSetEvent.equals(anchorDiscriminator('event', 'AutoExitSetEvent'))).toBe(true)
    expect(EVENT_DISCRIMINATORS.AutoExitEvent.equals(anchorDiscriminator('event', 'AutoExitEvent'))).toBe(true)
  })

  it.each([0n, 1_800_000_000n, I64_MAX, -2n])('decodes AutoExitSetEvent { market, user, deadline: i64 = %s }', (deadline) => {
    const expected: AutoExitSetEvent = { name: 'AutoExitSetEvent', market, user, deadline }
    expect(comparable(parseRouterEvents(routerIx(dataLine(setPayload(deadline)))))).toEqual(comparable([expected]))
  })

  it('decodes AutoExitEvent { market, user, cranker } after the SellEvent, in log order', () => {
    const sell = Buffer.concat([EVENT_DISCRIMINATORS.SellEvent, key(market), key(user), Buffer.alloc(32)])
    const expected: AutoExitEvent = { name: 'AutoExitEvent', market, user, cranker }
    const events = parseRouterEvents(routerIx(dataLine(sell), dataLine(exitPayload)))
    expect(events.map((e) => e.name)).toEqual(['SellEvent', 'AutoExitEvent'])
    expect(comparable(events.slice(1))).toEqual(comparable([expected]))
  })

  it('skips truncated or oversized Auto-Exit payloads', () => {
    const logs = routerIx(
      dataLine(setPayload(5n).subarray(0, 79)),
      dataLine(Buffer.concat([setPayload(5n), Buffer.alloc(1)])),
      dataLine(exitPayload.subarray(0, 103)),
      dataLine(Buffer.concat([exitPayload, Buffer.alloc(8)])),
    )
    expect(parseRouterEvents(logs)).toEqual([])
  })
})

/* ---------- LiteSVM: enable, disable, crank ---------- */

const BUY_DIVISOR = 60n
const DEADLINE_AHEAD_SECONDS = 2n
const CRANKER_LAMPORTS = 10_000_000_000n
const LITESVM_SIGNATURE_FEE = 5_000n
const LITESVM_TIMEOUT_MS = 120_000

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b
/** math.rs refund_for, mirrored locally (SDK-04 owns quote.ts refundFor). */
const refundForBasis = (basis: bigint, feeNumerator: bigint): bigint => {
  const refund = basis - ceilDiv(basis * feeNumerator, FEE_DENOMINATOR) - HAIRCUT_PER_EXIT
  return refund > 0n ? refund : 0n
}

describe('Auto-Exit on LiteSVM (wSOL quote)', () => {
  let setup: MarketSetup
  let cranker: Keypair
  let deadline: bigint

  const svm = (): LiteSVM => setup.svm
  const sendOk = (payer: Keypair, ixs: readonly TransactionInstruction[]): readonly string[] => {
    const res = setup.send(payer, ixs)
    if (!res.ok) throw new Error(`transaction failed: ${res.error}\n${res.logs.slice(-6).join('\n')}`)
    return res.logs
  }
  const eventsOf = (logs: readonly string[]): RouterEvent[] => parseRouterEvents(logs, cluster.routerProgramId)
  const positionOf = (owner: PublicKey): PositionAccount => {
    const address = findPositionPda(setup.accounts.market, owner, cluster.routerProgramId)
    const account = svm().getAccount(address)
    if (account === null) throw new Error(`no position for ${owner.toBase58()}`)
    return decodePosition(address, Buffer.from(account.data))
  }
  const feeNumerator = (): bigint => {
    const account = svm().getAccount(setup.accounts.market)
    if (account === null) throw new Error('market account missing')
    return decodeMarket(setup.accounts.market, Buffer.from(account.data)).feeNumerator
  }
  const delegationOf = (owner: PublicKey) => {
    const account = svm().getAccount(baseAtaOf(setup.accounts, owner))
    if (account === null) throw new Error(`no base ATA for ${owner.toBase58()}`)
    const decoded = AccountLayout.decode(Uint8Array.from(account.data).subarray(0, AccountLayout.span))
    return { delegate: decoded.delegateOption === 1 ? decoded.delegate : null, delegatedAmount: decoded.delegatedAmount }
  }
  const now = (): bigint => svm().getClock().unixTimestamp
  const warpTo = (unixTimestamp: bigint): void => {
    const c = svm().getClock()
    svm().setClock(new Clock(c.slot, c.epochStartTimestamp, c.epoch, c.leaderScheduleEpoch, unixTimestamp))
  }
  const setAutoExit = (owner: Keypair, value: bigint): readonly string[] =>
    sendOk(owner, setAutoExitInstructions({ cluster, accounts: setup.accounts, owner: owner.publicKey, deadline: value }))
  const crankExit = (owner: PublicKey) =>
    setup.send(cranker, [autoExitInstruction({ cluster, accounts: setup.accounts, cranker: cranker.publicKey, owner })])

  beforeAll(async () => {
    setup = await setupMarket({ traders: 2 })
    cranker = Keypair.generate()
    setup.svm.airdrop(cranker.publicKey, CRANKER_LAMPORTS)
    const threshold = readU64(setup.svm, setup.accounts.config, CONFIG_MIGRATION_QUOTE_THRESHOLD_OFFSET)
    setup.traders.forEach((trader) => sendOk(trader, buyInstructions({
      cluster, accounts: setup.accounts, user: trader.publicKey, amountIn: threshold / BUY_DIVISOR, minOut: 1n,
    })))
    deadline = now() + DEADLINE_AHEAD_SECONDS
  }, LITESVM_TIMEOUT_MS)

  it('enabling approves the market PDA for u64::MAX, stores the deadline and emits AutoExitSetEvent', () => {
    const owner = setup.traders[0]!
    const events = eventsOf(setAutoExit(owner, deadline))

    expect(delegationOf(owner.publicKey)).toEqual({ delegate: setup.accounts.market, delegatedAmount: U64_MAX })
    expect(positionOf(owner.publicKey).autoExitDeadline).toBe(deadline)
    const expected: AutoExitSetEvent = { name: 'AutoExitSetEvent', market: setup.accounts.market, user: owner.publicKey, deadline }
    expect(comparable(events)).toEqual(comparable([expected]))
  })

  it('disabling clears the deadline, revokes the delegate and emits AutoExitSetEvent with deadline 0', () => {
    const owner = setup.traders[1]!
    setAutoExit(owner, deadline)
    expect(delegationOf(owner.publicKey).delegate?.equals(setup.accounts.market)).toBe(true)

    const events = eventsOf(setAutoExit(owner, 0n))

    expect(delegationOf(owner.publicKey)).toEqual({ delegate: null, delegatedAmount: 0n })
    expect(positionOf(owner.publicKey).autoExitDeadline).toBe(0n)
    const expected: AutoExitSetEvent = { name: 'AutoExitSetEvent', market: setup.accounts.market, user: owner.publicKey, deadline: 0n }
    expect(comparable(events)).toEqual(comparable([expected]))
  })

  it('auto_exit before the deadline is rejected (AutoExitNotDue)', () => {
    const res = crankExit(setup.traders[0]!.publicKey)
    expect(res.ok).toBe(false)
    expect(res.logs.join('\n')).toMatch(/AutoExitNotDue/)
  })

  it('after the clock passes the deadline, a disabled position still cannot be auto-exited', () => {
    warpTo(deadline + 1n)
    expect(now()).toBe(deadline + 1n)
    const res = crankExit(setup.traders[1]!.publicKey)
    expect(res.ok).toBe(false)
    expect(res.logs.join('\n')).toMatch(/AutoExitNotDue/)
  })

  it('a third-party cranker exits the whole position; the owner receives refund_for(basis, fee)', () => {
    const owner = setup.traders[0]!
    const before = positionOf(owner.publicKey)
    const expectedRefund = refundForBasis(before.basis, feeNumerator())
    const ownerQuote = quoteAtaOf(setup.accounts, owner.publicKey)
    const quoteBefore = tokenAmount(svm(), ownerQuote)
    const ownerLamports = svm().getBalance(owner.publicKey)
    const crankerLamports = svm().getBalance(cranker.publicKey)

    const res = crankExit(owner.publicKey)
    if (!res.ok) throw new Error(`auto_exit failed: ${res.error}\n${res.logs.slice(-6).join('\n')}`)

    expect(expectedRefund > 0n).toBe(true)
    expect(tokenAmount(svm(), ownerQuote) - quoteBefore).toBe(expectedRefund)
    expect(tokenAmount(svm(), baseAtaOf(setup.accounts, owner.publicKey))).toBe(0n)
    const after = positionOf(owner.publicKey)
    expect([after.tokens, after.basis, after.autoExitDeadline]).toEqual([0n, 0n, 0n])
    expect(svm().getBalance(owner.publicKey)).toBe(ownerLamports)
    expect(svm().getBalance(cranker.publicKey)).toBe((crankerLamports ?? 0n) - LITESVM_SIGNATURE_FEE)

    const events = eventsOf(res.logs)
    expect(events.map((e) => e.name)).toEqual(['SellEvent', 'AutoExitEvent'])
    const [sell, exit] = events
    expect(sell?.name === 'SellEvent' && [sell.tokens, sell.basisPart, sell.refund]).toEqual([before.tokens, before.basis, expectedRefund])
    const expected: AutoExitEvent = { name: 'AutoExitEvent', market: setup.accounts.market, user: owner.publicKey, cranker: cranker.publicKey }
    expect(comparable([exit!])).toEqual(comparable([expected]))
  })
})
