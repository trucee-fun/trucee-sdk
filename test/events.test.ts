/**
 * SDK-07: router events decoded from transaction log messages (Anchor `emit!` -> "Program data: <base64>").
 */
import { Buffer } from 'buffer'
import { createHash } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import {
  DBC_PROGRAM_ID,
  EVENT_DISCRIMINATORS,
  ROUTER_PROGRAM_ID,
  parseRouterEvents,
} from '../src/index.js'
import type { BuyEvent, ClaimEvent, FinalizeEvent, RouterEvent, SellEvent } from '../src/index.js'

const ROUTER = ROUTER_PROGRAM_ID.toBase58()
const DBC = DBC_PROGRAM_ID.toBase58()
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PE1x8VyMW2nAQrK'
const SYSTEM = '11111111111111111111111111111111'
const U64_MAX = 2n ** 64n - 1n

const MARKET = new PublicKey('9DveBfq3oS9BnUsPjHC1Qa7RgFJhuKRXGx9mK8bpvU9L')
const USER = new PublicKey('FM1MD2v2DmNfveQ1nSazBobsSjKD5h98X7DziquuDhAR')

// --- borsh encoding helpers (test side) ---

const u64 = (value: bigint): Buffer => {
  const bytes = Buffer.alloc(8)
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setBigUint64(0, value, true)
  return bytes
}

const key = (pubkey: PublicKey): Buffer => Buffer.from(pubkey.toBytes())

const anchorEventDiscriminator = (name: string): Buffer =>
  Buffer.from(createHash('sha256').update(`event:${name}`).digest().subarray(0, 8))

const encodeEvent = (event: RouterEvent): Buffer => {
  const discriminator = EVENT_DISCRIMINATORS[event.name]
  switch (event.name) {
    case 'BuyEvent':
      return Buffer.concat([
        discriminator, key(event.market), key(event.user),
        u64(event.tokensOut), u64(event.netIntoCurve), u64(event.basis),
      ])
    case 'SellEvent':
      return Buffer.concat([
        discriminator, key(event.market), key(event.user),
        u64(event.tokens), u64(event.basisPart), u64(event.proceeds), u64(event.refund),
      ])
    case 'ClaimEvent':
      return Buffer.concat([discriminator, key(event.market), key(event.user), u64(event.basis), u64(event.share)])
    case 'FinalizeEvent':
      return Buffer.concat([discriminator, key(event.market), u64(event.surplus), u64(event.totalBasis)])
  }
}

const dataLine = (payload: Buffer): string => `Program data: ${payload.toString('base64')}`
const eventLine = (event: RouterEvent): string => dataLine(encodeEvent(event))

const invoke = (programId: string, depth: number): string => `Program ${programId} invoke [${depth}]`
const success = (programId: string): string => `Program ${programId} success`
const consumed = (programId: string): string => `Program ${programId} consumed 41234 of 200000 compute units`

/** One router instruction at depth 1 whose body lines run inside it. */
const routerIx = (...body: string[]): string[] => [
  invoke(ROUTER, 1),
  'Program log: Instruction: Buy',
  ...body,
  consumed(ROUTER),
  success(ROUTER),
]

/** PublicKeys compared by base58 so `toEqual` does not depend on BN internals. */
const comparable = (events: readonly RouterEvent[]): unknown[] =>
  events.map((event) =>
    Object.fromEntries(
      Object.entries(event).map(([field, value]) => [field, value instanceof PublicKey ? value.toBase58() : value]),
    ),
  )

// --- fixtures ---

const BUY: BuyEvent = {
  name: 'BuyEvent', market: MARKET, user: USER,
  tokensOut: 7_477_088_614_564n, netIntoCurve: 3_607_991n, basis: U64_MAX,
}
const SELL: SellEvent = {
  name: 'SellEvent', market: MARKET, user: USER,
  tokens: 75_983_494_228_130n, basisPart: 55_496_075n, proceeds: 1n, refund: U64_MAX - 1n,
}
const CLAIM: ClaimEvent = {
  name: 'ClaimEvent', market: MARKET, user: USER, basis: 121_732_158n, share: 15_242_161n,
}
const FINALIZE: FinalizeEvent = {
  name: 'FinalizeEvent', market: MARKET, surplus: 43_449_744n, totalBasis: 0n,
}

describe('parseRouterEvents: round trip', () => {
  it.each([BUY, SELL, CLAIM, FINALIZE])('decodes every field of $name', (event) => {
    const events = parseRouterEvents(routerIx(eventLine(event)))

    expect(comparable(events)).toEqual(comparable([event]))
  })

  it('returns PublicKey instances and bigint amounts', () => {
    const [event] = parseRouterEvents(routerIx(eventLine(BUY)))

    expect(event?.market).toBeInstanceOf(PublicKey)
    expect(event?.market.equals(MARKET)).toBe(true)
    expect(event?.name === 'BuyEvent' && event.user.equals(USER)).toBe(true)
    expect(event?.name === 'BuyEvent' && typeof event.tokensOut).toBe('bigint')
  })

  it('keeps log order across instructions in one transaction', () => {
    const logs = [...routerIx(eventLine(SELL)), ...routerIx(eventLine(BUY), eventLine(CLAIM)), ...routerIx(eventLine(FINALIZE))]

    expect(parseRouterEvents(logs).map((event) => event.name)).toEqual([
      'SellEvent', 'BuyEvent', 'ClaimEvent', 'FinalizeEvent',
    ])
  })

  it('returns an empty array when there are no logs', () => {
    expect(parseRouterEvents([])).toEqual([])
  })
})

describe('parseRouterEvents: invoke stack', () => {
  it('ignores Program data emitted inside a nested DBC CPI', () => {
    const dbcEventWithRouterDiscriminator = eventLine({ ...BUY, tokensOut: 1n })
    const logs = routerIx(
      invoke(DBC, 2),
      'Program log: Instruction: Swap2',
      invoke(TOKEN_2022, 3),
      success(TOKEN_2022),
      dbcEventWithRouterDiscriminator,
      dataLine(Buffer.from('dbc swap event payload')),
      consumed(DBC),
      success(DBC),
      eventLine(BUY),
    )

    expect(comparable(parseRouterEvents(logs))).toEqual(comparable([BUY]))
  })

  it('ignores Program data from other top-level programs', () => {
    const logs = [
      invoke(SYSTEM, 1), eventLine(SELL), success(SYSTEM),
      invoke(DBC, 1), eventLine(SELL), success(DBC),
      ...routerIx(eventLine(BUY)),
    ]

    expect(parseRouterEvents(logs).map((event) => event.name)).toEqual(['BuyEvent'])
  })

  it('ignores Program data outside any invocation', () => {
    expect(parseRouterEvents([eventLine(BUY)])).toEqual([])
  })

  it('still parses a failed router invocation, in order', () => {
    const logs = [
      invoke(ROUTER, 1),
      'Program log: Instruction: Sell',
      eventLine(SELL),
      eventLine(BUY),
      invoke(DBC, 2),
      'Program log: AnchorError occurred. Error Code: ExceededSlippage.',
      `Program ${DBC} consumed 30000 of 180000 compute units`,
      `Program ${DBC} failed: custom program error: 0x1772`,
      eventLine(CLAIM),
      consumed(ROUTER),
      `Program ${ROUTER} failed: custom program error: 0x1772`,
    ]

    expect(parseRouterEvents(logs).map((event) => event.name)).toEqual(['SellEvent', 'BuyEvent', 'ClaimEvent'])
  })

  it('pops the stack on a failed CPI so later router data is attributed to the router', () => {
    const logs = [
      invoke(ROUTER, 1),
      invoke(DBC, 2),
      'Program failed to complete: exceeded CUs meter at BPF instruction #1234',
      `Program ${DBC} failed: Program failed to complete`,
      eventLine(FINALIZE),
      `Program ${ROUTER} failed: Program failed to complete`,
      eventLine(SELL),
    ]

    expect(parseRouterEvents(logs).map((event) => event.name)).toEqual(['FinalizeEvent'])
  })

  it('honours a custom router program id', () => {
    const otherRouter = DBC
    const logs = [invoke(otherRouter, 1), eventLine(CLAIM), success(otherRouter), ...routerIx(eventLine(BUY))]

    expect(parseRouterEvents(logs, DBC_PROGRAM_ID).map((event) => event.name)).toEqual(['ClaimEvent'])
  })

  it('keeps events logged before a "Log truncated" marker', () => {
    const logs = [invoke(ROUTER, 1), eventLine(BUY), 'Log truncated']

    expect(parseRouterEvents(logs).map((event) => event.name)).toEqual(['BuyEvent'])
  })
})

describe('parseRouterEvents: skipped payloads', () => {
  it.each(['AutoExitSetEvent', 'AutoExitEvent'])('skips the unknown %s discriminator', (name) => {
    const unknown = Buffer.concat([anchorEventDiscriminator(name), key(MARKET), key(USER), u64(1_760_000_000n)])
    const logs = routerIx(dataLine(unknown), eventLine(SELL))

    expect(parseRouterEvents(logs).map((event) => event.name)).toEqual(['SellEvent'])
  })

  it('skips a v4 BuyEvent without the market field (64 bytes)', () => {
    const v4 = Buffer.concat([EVENT_DISCRIMINATORS.BuyEvent, key(USER), u64(1n), u64(2n), u64(3n)])

    expect(parseRouterEvents(routerIx(dataLine(v4)))).toEqual([])
  })

  it('skips truncated and oversized payloads', () => {
    const full = encodeEvent(SELL)
    const logs = routerIx(
      dataLine(full.subarray(0, full.length - 1)),
      dataLine(Buffer.concat([full, Buffer.from([0])])),
      dataLine(EVENT_DISCRIMINATORS.ClaimEvent),
      dataLine(EVENT_DISCRIMINATORS.FinalizeEvent.subarray(0, 4)),
      eventLine(CLAIM),
    )

    expect(parseRouterEvents(logs).map((event) => event.name)).toEqual(['ClaimEvent'])
  })

  it('skips malformed base64 without throwing', () => {
    const valid = encodeEvent(FINALIZE).toString('base64')
    const logs = routerIx(
      'Program data: ',
      'Program data:',
      'Program data: !!!not-base64!!!',
      `Program data: ${valid.slice(0, -1)}`,
      `Program data: ${valid}$`,
      `Program data: ${valid} ${valid}`,
      `Program log: ${valid}`,
      eventLine(FINALIZE),
    )

    expect(() => parseRouterEvents(logs)).not.toThrow()
    expect(comparable(parseRouterEvents(logs))).toEqual(comparable([FINALIZE]))
  })

  it('ignores non-string log entries', () => {
    const logs = [invoke(ROUTER, 1), 42, null, eventLine(BUY), success(ROUTER)] as unknown as string[]

    expect(parseRouterEvents(logs).map((event) => event.name)).toEqual(['BuyEvent'])
  })

  it('throws a TypeError when logs is not an array', () => {
    expect(() => parseRouterEvents(null as unknown as string[])).toThrow(TypeError)
  })
})

describe('parseRouterEvents: devnet golden (tx 4brtEcbh…, first router buy)', () => {
  it('BuyEvent layout is 96 bytes with the market at bytes 8..40', () => {
    const payload = encodeEvent({ ...BUY, market: new PublicKey('9DveBfq3oS9BnUsPjHC1Qa7RgFJhuKRXGx9mK8bpvU9L') })

    expect(payload.subarray(0, 8).toString('hex')).toBe('67f4521f2cf57777')
    expect(payload).toHaveLength(96)
    expect(payload).toHaveLength(8 + 32 + 32 + 3 * 8)

    const [event] = parseRouterEvents(routerIx(dataLine(payload)))

    expect(event?.name).toBe('BuyEvent')
    expect(event?.market.toBase58()).toBe('9DveBfq3oS9BnUsPjHC1Qa7RgFJhuKRXGx9mK8bpvU9L')
    expect(Buffer.from(event?.market.toBytes() ?? []).equals(payload.subarray(8, 40))).toBe(true)
  })
})
