/**
 * Decoders and fetchers for router Market and Position accounts.
 * Layouts mirror zpvp/programs/zpvp_router/src/lib.rs (little-endian borsh, 8-byte Anchor discriminator).
 * Later program versions may append fields, so decoders accept longer data and fetchers never filter on dataSize.
 */
import { Buffer } from 'buffer'
import { PublicKey, type Connection, type GetProgramAccountsFilter } from '@solana/web3.js'
import {
  MARKET_ACCOUNT_SIZE,
  POSITION_ACCOUNT_SIZE_V1,
  POSITION_ACCOUNT_SIZE_V2,
  ROUTER_PROGRAM_ID,
} from './constants.js'
import type { MarketAccount, MarketAccounts, PositionAccount } from './types.js'

const DISCRIMINATOR_SIZE = 8
const PUBKEY_SIZE = 32

/** sha256("account:Market")[..8] */
const MARKET_DISCRIMINATOR: readonly number[] = Object.freeze([219, 190, 213, 55, 0, 227, 198, 154])
/** sha256("account:Position")[..8] */
const POSITION_DISCRIMINATOR: readonly number[] = Object.freeze([170, 188, 143, 228, 122, 64, 247, 208])

const MARKET_OFFSETS = Object.freeze({
  pool: 8,
  config: 40,
  baseMint: 72,
  quoteMint: 104,
  baseVault: 136,
  quoteVault: 168,
  bufferVault: 200,
  feeNumerator: 232,
  bump: 240,
  totalBasis: 241,
  finalized: 249,
  surplusSnapshot: 250,
  basisSnapshot: 258,
  surplusClaimed: 266,
})

const POSITION_OFFSETS = Object.freeze({
  owner: 8,
  market: 40,
  tokens: 72,
  basis: 80,
  bump: 88,
  autoExitDeadline: 89,
})

/** Bounds-checked little-endian reads over account data. */
interface AccountReader {
  readonly length: number
  pubkey(offset: number): PublicKey
  u8(offset: number): number
  u64(offset: number): bigint
  i64(offset: number): bigint
  bool(offset: number, field: string): boolean
}

const toBytes = (data: Uint8Array, label: string): Uint8Array => {
  if (!(data instanceof Uint8Array)) {
    throw new TypeError(`${label}: account data must be a Buffer or Uint8Array`)
  }
  return data
}

const createReader = (bytes: Uint8Array, label: string): AccountReader => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return {
    length: bytes.length,
    pubkey: (offset) => new PublicKey(bytes.subarray(offset, offset + PUBKEY_SIZE)),
    u8: (offset) => view.getUint8(offset),
    u64: (offset) => view.getBigUint64(offset, true),
    i64: (offset) => view.getBigInt64(offset, true),
    bool: (offset, field) => {
      const value = view.getUint8(offset)
      if (value > 1) throw new Error(`${label}: invalid bool ${value} in ${field}`)
      return value === 1
    },
  }
}

const describeBytes = (bytes: Uint8Array): string => `[${Array.from(bytes).join(',')}]`

const assertDiscriminator = (bytes: Uint8Array, expected: readonly number[], label: string): void => {
  const actual = bytes.subarray(0, DISCRIMINATOR_SIZE)
  const matches = actual.length === DISCRIMINATOR_SIZE && expected.every((byte, i) => actual[i] === byte)
  if (!matches) {
    throw new Error(`${label}: invalid discriminator ${describeBytes(actual)}, expected ${describeBytes(Uint8Array.from(expected))}`)
  }
}

const assertMinLength = (bytes: Uint8Array, minLength: number, label: string): void => {
  if (bytes.length < minLength) {
    throw new Error(`${label}: data is ${bytes.length} bytes, expected at least ${minLength}`)
  }
}

/** Validates the discriminator, then the minimum size, and returns a reader over the data. */
const openAccount = (
  address: PublicKey,
  data: Uint8Array,
  kind: 'Market' | 'Position',
  discriminator: readonly number[],
  minLength: number,
): AccountReader => {
  const label = `${kind} ${address.toBase58()}`
  const bytes = toBytes(data, label)
  assertDiscriminator(bytes, discriminator, label)
  assertMinLength(bytes, minLength, label)
  return createReader(bytes, label)
}

export function decodeMarket(address: PublicKey, data: Buffer): MarketAccount {
  const read = openAccount(address, data, 'Market', MARKET_DISCRIMINATOR, MARKET_ACCOUNT_SIZE)
  return Object.freeze({
    address,
    pool: read.pubkey(MARKET_OFFSETS.pool),
    config: read.pubkey(MARKET_OFFSETS.config),
    baseMint: read.pubkey(MARKET_OFFSETS.baseMint),
    quoteMint: read.pubkey(MARKET_OFFSETS.quoteMint),
    baseVault: read.pubkey(MARKET_OFFSETS.baseVault),
    quoteVault: read.pubkey(MARKET_OFFSETS.quoteVault),
    bufferVault: read.pubkey(MARKET_OFFSETS.bufferVault),
    feeNumerator: read.u64(MARKET_OFFSETS.feeNumerator),
    bump: read.u8(MARKET_OFFSETS.bump),
    totalBasis: read.u64(MARKET_OFFSETS.totalBasis),
    finalized: read.bool(MARKET_OFFSETS.finalized, 'finalized'),
    surplusSnapshot: read.u64(MARKET_OFFSETS.surplusSnapshot),
    basisSnapshot: read.u64(MARKET_OFFSETS.basisSnapshot),
    surplusClaimed: read.u64(MARKET_OFFSETS.surplusClaimed),
  })
}

/** Accepts both the 89-byte (no auto-exit) and the 97-byte layout. */
export function decodePosition(address: PublicKey, data: Buffer): PositionAccount {
  const read = openAccount(address, data, 'Position', POSITION_DISCRIMINATOR, POSITION_ACCOUNT_SIZE_V1)
  const hasAutoExit = read.length >= POSITION_ACCOUNT_SIZE_V2
  return Object.freeze({
    address,
    owner: read.pubkey(POSITION_OFFSETS.owner),
    market: read.pubkey(POSITION_OFFSETS.market),
    tokens: read.u64(POSITION_OFFSETS.tokens),
    basis: read.u64(POSITION_OFFSETS.basis),
    bump: read.u8(POSITION_OFFSETS.bump),
    autoExitDeadline: hasAutoExit ? read.i64(POSITION_OFFSETS.autoExitDeadline) : null,
  })
}

/** Resolves null when the account does not exist. */
export async function fetchMarket(connection: Connection, market: PublicKey): Promise<MarketAccount | null> {
  const info = await connection.getAccountInfo(market)
  return info === null ? null : decodeMarket(market, info.data)
}

const memcmp = (offset: number, bytes: readonly number[]): GetProgramAccountsFilter => ({
  memcmp: { offset, bytes: Buffer.from(bytes).toString('base64'), encoding: 'base64' },
})

export async function fetchAllMarkets(
  connection: Connection,
  routerProgramId: PublicKey = ROUTER_PROGRAM_ID,
): Promise<MarketAccount[]> {
  const accounts = await connection.getProgramAccounts(routerProgramId, {
    filters: [memcmp(0, MARKET_DISCRIMINATOR)],
  })
  return accounts.map(({ pubkey, account }) => decodeMarket(pubkey, account.data))
}

export async function fetchPositionsByOwner(
  connection: Connection,
  owner: PublicKey,
  routerProgramId: PublicKey = ROUTER_PROGRAM_ID,
): Promise<PositionAccount[]> {
  const accounts = await connection.getProgramAccounts(routerProgramId, {
    filters: [
      memcmp(0, POSITION_DISCRIMINATOR),
      { memcmp: { offset: POSITION_OFFSETS.owner, bytes: owner.toBase58() } },
    ],
  })
  return accounts.map(({ pubkey, account }) => decodePosition(pubkey, account.data))
}

export function marketAccountsFor(market: MarketAccount, quoteTokenProgram: PublicKey): MarketAccounts {
  return Object.freeze({
    market: market.address,
    pool: market.pool,
    config: market.config,
    baseMint: market.baseMint,
    quoteMint: market.quoteMint,
    baseVault: market.baseVault,
    quoteVault: market.quoteVault,
    bufferVault: market.bufferVault,
    quoteTokenProgram,
  })
}
