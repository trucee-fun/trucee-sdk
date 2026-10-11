/**
 * SDK-24: router program-account scans skip legacy-size accounts.
 * The devnet router still owns 241-byte Markets and 89-byte pre-v5 Positions. A scan that filtered on the
 * discriminator alone handed them to the strict decoders, and one legacy Market failed the whole call.
 * SDK-26: router v6 (ONC-15) allocates 300-byte Markets, so the Market scan lists both 274-byte (v5) and
 * 300-byte (v6) Markets, whichever router version the cluster runs.
 * The mocked RPC below applies memcmp and dataSize filters the way a real RPC node does.
 */
import { Buffer } from 'buffer'
import {
  PublicKey,
  type AccountInfo,
  type Connection,
  type GetProgramAccountsConfig,
  type GetProgramAccountsFilter,
} from '@solana/web3.js'
import { describe, expect, it, vi } from 'vitest'
import { decodeMarket, decodePosition, fetchAllMarkets, fetchPositionsByOwner } from '../src/accounts.js'
import {
  MARKET_ACCOUNT_SIZE,
  MARKET_ACCOUNT_SIZE_V6,
  POSITION_ACCOUNT_SIZE_V1,
  POSITION_ACCOUNT_SIZE_V2,
  ROUTER_PROGRAM_ID,
} from '../src/constants.js'
import type { MarketAccount } from '../src/types.js'

const MARKET_DISC = [219, 190, 213, 55, 0, 227, 198, 154]
const POSITION_DISC = [170, 188, 143, 228, 122, 64, 247, 208]
/** Market before total_basis and the snapshots: discriminator | 7 pubkeys | fee u64 | bump u8. */
const LEGACY_MARKET_SIZE = 241
/** Router v6 Retention fields appended to the v5 Market: basis_bought_total u64 | retention u8 | fees_settled u8 | 2 x u64. */
const V6_RETENTION_FIELDS_SIZE = 8 + 1 + 1 + 8 + 8
const POSITION_OWNER_OFFSET = 8
const AUTO_EXIT_DEADLINE = 1_791_763_200n

const key = (seed: number): PublicKey => new PublicKey(Buffer.alloc(32, seed))

const OWNER = key(9)
const OTHER_OWNER = key(11)

const buildMarket = (size: number): Buffer => {
  const data = Buffer.alloc(size)
  Buffer.from(MARKET_DISC).copy(data, 0)
  for (let i = 0; i < 7; i += 1) key(i + 1).toBuffer().copy(data, 8 + 32 * i)
  if (size >= MARKET_ACCOUNT_SIZE) {
    data.writeBigUInt64LE(25_000_000n, 232)
    data.writeUInt8(253, 240)
    data.writeBigUInt64LE(7_000n, 241)
    data.writeUInt8(1, 249)
    data.writeBigUInt64LE(11n, 250)
    data.writeBigUInt64LE(22n, 258)
    data.writeBigUInt64LE(33n, 266)
  }
  return data
}

/** A v6 Market: the v5 bytes of buildMarket, then non-zero Retention fields at offsets 274/282/283/284/292. */
const buildV6Market = (): Buffer => {
  const data = Buffer.alloc(MARKET_ACCOUNT_SIZE_V6)
  buildMarket(MARKET_ACCOUNT_SIZE).copy(data, 0)
  data.writeBigUInt64LE(9_000n, 274)
  data.writeUInt8(1, 282)
  data.writeUInt8(1, 283)
  data.writeBigUInt64LE(44n, 284)
  data.writeBigUInt64LE(55n, 292)
  return data
}

const buildPosition = (owner: PublicKey, size: number): Buffer => {
  const data = Buffer.alloc(size)
  Buffer.from(POSITION_DISC).copy(data, 0)
  owner.toBuffer().copy(data, POSITION_OWNER_OFFSET)
  key(10).toBuffer().copy(data, 40)
  data.writeBigUInt64LE(1_000n, 72)
  data.writeBigUInt64LE(500n, 80)
  data.writeUInt8(254, 88)
  if (size >= POSITION_ACCOUNT_SIZE_V2) data.writeBigInt64LE(AUTO_EXIT_DEADLINE, 89)
  return data
}

interface ProgramAccount {
  readonly pubkey: PublicKey
  readonly account: AccountInfo<Buffer>
}

const programAccount = (pubkey: PublicKey, data: Buffer): ProgramAccount => ({
  pubkey,
  account: { data, executable: false, lamports: 1_000_000, owner: ROUTER_PROGRAM_ID, rentEpoch: 0 },
})

const V5_MARKET = programAccount(key(100), buildMarket(MARKET_ACCOUNT_SIZE))
const LEGACY_MARKET = programAccount(key(101), buildMarket(LEGACY_MARKET_SIZE))
const V6_MARKET = programAccount(key(105), buildV6Market())
const CURRENT_POSITION = programAccount(key(102), buildPosition(OWNER, POSITION_ACCOUNT_SIZE_V2))
const LEGACY_POSITION = programAccount(key(103), buildPosition(OWNER, POSITION_ACCOUNT_SIZE_V1))
const OTHER_OWNER_POSITION = programAccount(key(104), buildPosition(OTHER_OWNER, POSITION_ACCOUNT_SIZE_V2))

/** What a router owns across versions: one of each layout, legacy accounts listed first. */
const ROUTER_ACCOUNTS: readonly ProgramAccount[] = Object.freeze([
  LEGACY_MARKET,
  V5_MARKET,
  V6_MARKET,
  LEGACY_POSITION,
  CURRENT_POSITION,
  OTHER_OWNER_POSITION,
])

/** Base64 as sent by the SDK; base58 here is always a 32-byte pubkey (the owner filter). */
const memcmpBytes = (bytes: string, encoding: 'base58' | 'base64' | undefined): Uint8Array =>
  encoding === 'base64' ? Buffer.from(bytes, 'base64') : new PublicKey(bytes).toBytes()

const matchesFilter = (data: Buffer, filter: GetProgramAccountsFilter): boolean => {
  if ('dataSize' in filter) return data.length === filter.dataSize
  const { offset, bytes, encoding } = filter.memcmp
  const expected = memcmpBytes(bytes, encoding)
  return data.length >= offset + expected.length && expected.every((byte, i) => data[offset + i] === byte)
}

type GetProgramAccountsFn = (programId: PublicKey, config?: GetProgramAccountsConfig) => Promise<ProgramAccount[]>

/** A connection whose getProgramAccounts applies every filter like an RPC node and records what it served. */
const mockRpc = (accounts: readonly ProgramAccount[]) => {
  const served: PublicKey[] = []
  const getProgramAccounts = vi.fn<GetProgramAccountsFn>(async (programId, config) => {
    const filters = config?.filters ?? []
    const matched = accounts.filter(
      ({ account }) => account.owner.equals(programId) && filters.every((filter) => matchesFilter(account.data, filter)),
    )
    served.push(...matched.map(({ pubkey }) => pubkey))
    return matched
  })
  const connection = { getProgramAccounts } as unknown as Connection
  return { connection, getProgramAccounts, served }
}

const filtersSent = (
  fn: ReturnType<typeof mockRpc>['getProgramAccounts'],
  call: number = 0,
): readonly GetProgramAccountsFilter[] => fn.mock.calls[call]?.[1]?.filters ?? []

const marketDiscriminatorFilter: GetProgramAccountsFilter = {
  memcmp: { offset: 0, bytes: Buffer.from(MARKET_DISC).toString('base64'), encoding: 'base64' },
}

/** Every field but the address, so Markets at different addresses compare by content. */
const marketFields = ({ address: _address, ...fields }: MarketAccount): Omit<MarketAccount, 'address'> => fields

const base58s = (keys: readonly PublicKey[]): string[] => keys.map((k) => k.toBase58())

describe('legacy fixtures', () => {
  it('reproduce the devnet failure when a scan filters on the discriminator only', async () => {
    const { connection } = mockRpc(ROUTER_ACCOUNTS)
    const discriminatorOnly: GetProgramAccountsFilter = {
      memcmp: { offset: 0, bytes: Buffer.from(MARKET_DISC).toString('base64'), encoding: 'base64' },
    }

    const markets = await connection.getProgramAccounts(ROUTER_PROGRAM_ID, { filters: [discriminatorOnly] })

    expect(base58s(markets.map(({ pubkey }) => pubkey))).toEqual(
      base58s([LEGACY_MARKET.pubkey, V5_MARKET.pubkey, V6_MARKET.pubkey]),
    )
    expect(() => decodeMarket(LEGACY_MARKET.pubkey, LEGACY_MARKET.account.data)).toThrow(/241 bytes/)
  })
})

describe('market account sizes', () => {
  it('MARKET_ACCOUNT_SIZE_V6 is the v5 Market plus the 26-byte Retention fields', () => {
    expect(MARKET_ACCOUNT_SIZE).toBe(274)
    expect(MARKET_ACCOUNT_SIZE_V6).toBe(300)
    expect(MARKET_ACCOUNT_SIZE_V6).toBe(MARKET_ACCOUNT_SIZE + V6_RETENTION_FIELDS_SIZE)
  })
})

describe('fetchAllMarkets with legacy accounts', () => {
  it('runs one scan per Market size, each with the Market discriminator', async () => {
    const { connection, getProgramAccounts } = mockRpc(ROUTER_ACCOUNTS)

    await fetchAllMarkets(connection)

    expect(getProgramAccounts).toHaveBeenCalledTimes(2)
    expect(filtersSent(getProgramAccounts, 0)).toEqual([marketDiscriminatorFilter, { dataSize: MARKET_ACCOUNT_SIZE }])
    expect(filtersSent(getProgramAccounts, 1)).toEqual([marketDiscriminatorFilter, { dataSize: MARKET_ACCOUNT_SIZE_V6 }])
  })

  it('returns v5 and v6 Markets and is never served the 241-byte Market', async () => {
    const { connection, served } = mockRpc(ROUTER_ACCOUNTS)

    const markets = await fetchAllMarkets(connection)

    expect(base58s(markets.map((m) => m.address))).toEqual(base58s([V5_MARKET.pubkey, V6_MARKET.pubkey]))
    expect(base58s(served)).not.toContain(LEGACY_MARKET.pubkey.toBase58())
  })

  it('lists the Markets of a v6-only router', async () => {
    const { connection } = mockRpc([LEGACY_MARKET, V6_MARKET])

    const markets = await fetchAllMarkets(connection)

    expect(base58s(markets.map((m) => m.address))).toEqual(base58s([V6_MARKET.pubkey]))
  })

  it('merges the scans by address, so an account served by both is listed once', async () => {
    const getProgramAccounts = vi.fn<GetProgramAccountsFn>(async () => [V5_MARKET, V6_MARKET])
    const connection = { getProgramAccounts } as unknown as Connection

    const markets = await fetchAllMarkets(connection)

    expect(getProgramAccounts).toHaveBeenCalledTimes(2)
    expect(base58s(markets.map((m) => m.address))).toEqual(base58s([V5_MARKET.pubkey, V6_MARKET.pubkey]))
  })
})

describe('decodeMarket on a v6 Market', () => {
  it('decodes the 300-byte layout and ignores the 26 Retention bytes', () => {
    const v6 = decodeMarket(V6_MARKET.pubkey, V6_MARKET.account.data)
    const v5 = decodeMarket(V5_MARKET.pubkey, V5_MARKET.account.data)

    expect(v6.address.equals(V6_MARKET.pubkey)).toBe(true)
    expect(marketFields(v6)).toEqual(marketFields(v5))
    expect(Object.keys(v6).sort()).toEqual(Object.keys(v5).sort())
    expect(v6.surplusClaimed).toBe(33n)
  })
})

describe('fetchPositionsByOwner with legacy accounts', () => {
  it('sends the Position discriminator, the owner and the current Position size as filters', async () => {
    const { connection, getProgramAccounts } = mockRpc(ROUTER_ACCOUNTS)

    await fetchPositionsByOwner(connection, OWNER)

    expect(getProgramAccounts).toHaveBeenCalledTimes(1)
    expect(filtersSent(getProgramAccounts)).toEqual([
      { memcmp: { offset: 0, bytes: Buffer.from(POSITION_DISC).toString('base64'), encoding: 'base64' } },
      { memcmp: { offset: POSITION_OWNER_OFFSET, bytes: OWNER.toBase58() } },
      { dataSize: POSITION_ACCOUNT_SIZE_V2 },
    ])
  })

  it("returns only the owner's current-layout Positions and is never served the 89-byte Position", async () => {
    const { connection, served } = mockRpc(ROUTER_ACCOUNTS)

    const positions = await fetchPositionsByOwner(connection, OWNER)

    expect(positions.map((p) => [p.address.toBase58(), p.autoExitDeadline])).toEqual([
      [CURRENT_POSITION.pubkey.toBase58(), AUTO_EXIT_DEADLINE],
    ])
    expect(base58s(served)).not.toContain(LEGACY_POSITION.pubkey.toBase58())
  })
})

describe('decodePosition called directly', () => {
  it('still accepts an 89-byte Position', () => {
    const position = decodePosition(LEGACY_POSITION.pubkey, LEGACY_POSITION.account.data)

    expect(position.owner.equals(OWNER)).toBe(true)
    expect(position.autoExitDeadline).toBeNull()
  })
})
