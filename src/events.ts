/**
 * Router events emitted with Anchor `emit!` ("Program data: <base64>" log lines).
 *
 * Each payload is base64(discriminator 8 | borsh fields). A `Program data:` line belongs to the innermost
 * program of the invoke stack, so data logged by a CPI target (DBC, Token-2022, the hook) is never read as a
 * router event. Unknown discriminators, malformed base64 and payloads whose length differs from the layout
 * (truncated, oversized, or the pre-ONC-10 v4 layout without `market`) are skipped rather than thrown.
 */
import { Buffer } from 'buffer'
import { PublicKey } from '@solana/web3.js'
import { ROUTER_PROGRAM_ID } from './constants.js'
import type { BuyEvent, ClaimEvent, FinalizeEvent, RouterEvent, SellEvent } from './types.js'

/** Anchor event discriminators: sha256("event:<Name>")[..8]. */
export const EVENT_DISCRIMINATORS: Readonly<Record<RouterEvent['name'], Buffer>> = Object.freeze({
  BuyEvent: Buffer.from([103, 244, 82, 31, 44, 245, 119, 119]),
  SellEvent: Buffer.from([62, 47, 55, 10, 165, 3, 220, 42]),
  ClaimEvent: Buffer.from([93, 15, 70, 170, 48, 140, 212, 219]),
  FinalizeEvent: Buffer.from([115, 140, 131, 4, 181, 52, 170, 148]),
})

const DISCRIMINATOR_SIZE = 8
const PUBKEY_SIZE = 32
const U64_SIZE = 8

const PROGRAM_DATA_PREFIX = 'Program data: '
const BASE58_ID = '[1-9A-HJ-NP-Za-km-z]{32,44}'
const INVOKE_LINE = new RegExp(`^Program (${BASE58_ID}) invoke \\[\\d+\\]$`)
const EXIT_LINE = new RegExp(`^Program (${BASE58_ID}) (?:success$|failed: )`)
/** Canonical padded base64 of a single `sol_log_data` slice (Anchor `emit!` logs exactly one). */
const BASE64_PAYLOAD = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/** Sequential borsh reader over one payload, starting after the discriminator. */
interface FieldReader {
  readonly pubkey: () => PublicKey
  readonly u64: () => bigint
}

interface EventLayout {
  readonly name: RouterEvent['name']
  /** Total payload length, discriminator included. */
  readonly size: number
  readonly decode: (read: FieldReader) => RouterEvent
}

const layoutSize = (pubkeys: number, u64s: number): number =>
  DISCRIMINATOR_SIZE + pubkeys * PUBKEY_SIZE + u64s * U64_SIZE

const decodeBuy = (read: FieldReader): BuyEvent => ({
  name: 'BuyEvent',
  market: read.pubkey(),
  user: read.pubkey(),
  tokensOut: read.u64(),
  netIntoCurve: read.u64(),
  basis: read.u64(),
})

const decodeSell = (read: FieldReader): SellEvent => ({
  name: 'SellEvent',
  market: read.pubkey(),
  user: read.pubkey(),
  tokens: read.u64(),
  basisPart: read.u64(),
  proceeds: read.u64(),
  refund: read.u64(),
})

const decodeClaim = (read: FieldReader): ClaimEvent => ({
  name: 'ClaimEvent',
  market: read.pubkey(),
  user: read.pubkey(),
  basis: read.u64(),
  share: read.u64(),
})

const decodeFinalize = (read: FieldReader): FinalizeEvent => ({
  name: 'FinalizeEvent',
  market: read.pubkey(),
  surplus: read.u64(),
  totalBasis: read.u64(),
})

/** Layouts of zpvp_router's #[event] structs (ONC-10 source: every event leads with `market`). */
const EVENT_LAYOUTS: readonly EventLayout[] = Object.freeze([
  { name: 'BuyEvent', size: layoutSize(2, 3), decode: decodeBuy },
  { name: 'SellEvent', size: layoutSize(2, 4), decode: decodeSell },
  { name: 'ClaimEvent', size: layoutSize(2, 2), decode: decodeClaim },
  { name: 'FinalizeEvent', size: layoutSize(1, 2), decode: decodeFinalize },
])

const hasPrefix = (data: Uint8Array, prefix: Uint8Array): boolean =>
  data.length >= prefix.length && prefix.every((byte, i) => data[i] === byte)

/** Fields are read in declaration order; each payload gets its own reader and cursor. */
const createFieldReader = (data: Uint8Array): FieldReader => {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let offset = DISCRIMINATOR_SIZE
  const advance = (size: number): number => {
    const start = offset
    offset += size
    return start
  }
  return {
    pubkey: () => {
      const start = advance(PUBKEY_SIZE)
      return new PublicKey(data.slice(start, start + PUBKEY_SIZE))
    },
    u64: () => view.getBigUint64(advance(U64_SIZE), true),
  }
}

/** Decodes one `Program data:` payload, or null when it is not a well-formed known router event. */
const decodeEventPayload = (payload: string): RouterEvent | null => {
  if (!BASE64_PAYLOAD.test(payload)) return null
  const data = Buffer.from(payload, 'base64')
  const layout = EVENT_LAYOUTS.find((candidate) => hasPrefix(data, EVENT_DISCRIMINATORS[candidate.name]))
  if (layout === undefined || data.length !== layout.size) return null
  return layout.decode(createFieldReader(data))
}

interface ParseState {
  /** Program ids of the invoke stack, innermost last. */
  readonly stack: readonly string[]
  readonly events: readonly RouterEvent[]
}

const step = (state: ParseState, line: string, routerId: string): ParseState => {
  const invoked = INVOKE_LINE.exec(line)
  if (invoked?.[1] !== undefined) return { ...state, stack: [...state.stack, invoked[1]] }
  if (EXIT_LINE.test(line)) return { ...state, stack: state.stack.slice(0, -1) }
  if (!line.startsWith(PROGRAM_DATA_PREFIX) || state.stack.at(-1) !== routerId) return state
  const event = decodeEventPayload(line.slice(PROGRAM_DATA_PREFIX.length))
  return event === null ? state : { ...state, events: [...state.events, event] }
}

/**
 * Decodes router events from a transaction's log messages, in log order.
 *
 * Only `Program data:` lines logged while the router is the innermost invoked program are decoded; events
 * logged before a failure are still returned (check the transaction error separately). Lines that are not
 * strings, unknown discriminators and malformed payloads are skipped.
 *
 * @throws TypeError when `logs` is not an array.
 */
export function parseRouterEvents(
  logs: readonly string[],
  routerProgramId: PublicKey = ROUTER_PROGRAM_ID,
): RouterEvent[] {
  if (!Array.isArray(logs)) throw new TypeError('parseRouterEvents: logs must be an array of log message strings')
  const routerId = routerProgramId.toBase58()
  const initial: ParseState = { stack: [], events: [] }
  const final = logs.reduce<ParseState>(
    (state, line: unknown) => (typeof line === 'string' ? step(state, line, routerId) : state),
    initial,
  )
  return [...final.events]
}
