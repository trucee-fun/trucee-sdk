/**
 * SDK-06: router Market / Position decoders and RPC fetchers.
 * Golden values come from a devnet Market fetched once into test/fixtures (no network in this test).
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Buffer } from 'buffer'
import { PublicKey, type AccountInfo, type Connection } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { describe, expect, it, vi } from 'vitest'
import {
  decodeMarket,
  decodePosition,
  fetchAllMarkets,
  fetchMarket,
  fetchPositionsByOwner,
  marketAccountsFor,
} from '../src/accounts.js'
import {
  MARKET_ACCOUNT_SIZE,
  POSITION_ACCOUNT_SIZE_V1,
  POSITION_ACCOUNT_SIZE_V2,
  ROUTER_PROGRAM_ID,
} from '../src/constants.js'

const MARKET_DISC = [219, 190, 213, 55, 0, 227, 198, 154]
const POSITION_DISC = [170, 188, 143, 228, 122, 64, 247, 208]

interface AccountFixture {
  readonly address: string
  readonly owner: string
  readonly lamports: number
  readonly data: string
  readonly encoding: string
}

const loadFixture = (name: string): AccountFixture => {
  const parsed: unknown = JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))
  const fixture = parsed as AccountFixture
  if (typeof fixture.address !== 'string' || typeof fixture.data !== 'string' || fixture.encoding !== 'base64') {
    throw new Error(`fixture ${name} is malformed`)
  }
  return fixture
}

const DEVNET_MARKET = loadFixture('devnet-market-4uLad.json')
const DEVNET_MARKET_ADDRESS = new PublicKey(DEVNET_MARKET.address)
const devnetMarketData = (): Buffer => Buffer.from(DEVNET_MARKET.data, 'base64')

const key = (seed: number): PublicKey => new PublicKey(Buffer.alloc(32, seed))

const accountInfo = (data: Buffer, owner: PublicKey = ROUTER_PROGRAM_ID): AccountInfo<Buffer> => ({
  data,
  executable: false,
  lamports: 1_000_000,
  owner,
  rentEpoch: 0,
})

interface MarketFields {
  readonly pubkeys: readonly PublicKey[]
  readonly feeNumerator: bigint
  readonly bump: number
  readonly totalBasis: bigint
  readonly finalized: number
  readonly surplusSnapshot: bigint
  readonly basisSnapshot: bigint
  readonly surplusClaimed: bigint
}

const SAMPLE_MARKET: MarketFields = {
  pubkeys: [1, 2, 3, 4, 5, 6, 7].map(key),
  feeNumerator: 25_000_000n,
  bump: 253,
  totalBasis: 18_446_744_073_709_551_615n,
  finalized: 0,
  surplusSnapshot: 11n,
  basisSnapshot: 22n,
  surplusClaimed: 33n,
}

const buildMarket = (fields: MarketFields, size: number = MARKET_ACCOUNT_SIZE): Buffer => {
  const data = Buffer.alloc(size)
  Buffer.from(MARKET_DISC).copy(data, 0)
  fields.pubkeys.forEach((pubkey, i) => pubkey.toBuffer().copy(data, 8 + 32 * i))
  data.writeBigUInt64LE(fields.feeNumerator, 232)
  data.writeUInt8(fields.bump, 240)
  data.writeBigUInt64LE(fields.totalBasis, 241)
  data.writeUInt8(fields.finalized, 249)
  data.writeBigUInt64LE(fields.surplusSnapshot, 250)
  data.writeBigUInt64LE(fields.basisSnapshot, 258)
  data.writeBigUInt64LE(fields.surplusClaimed, 266)
  return data
}

interface PositionFields {
  readonly owner: PublicKey
  readonly market: PublicKey
  readonly tokens: bigint
  readonly basis: bigint
  readonly bump: number
  readonly autoExitDeadline: bigint | null
}

const SAMPLE_POSITION: PositionFields = {
  owner: key(9),
  market: key(10),
  tokens: 123_456_789_000n,
  basis: 987_654_321n,
  bump: 254,
  autoExitDeadline: null,
}

const buildPosition = (fields: PositionFields, size?: number): Buffer => {
  const hasDeadline = fields.autoExitDeadline !== null
  const data = Buffer.alloc(size ?? (hasDeadline ? POSITION_ACCOUNT_SIZE_V2 : POSITION_ACCOUNT_SIZE_V1))
  Buffer.from(POSITION_DISC).copy(data, 0)
  fields.owner.toBuffer().copy(data, 8)
  fields.market.toBuffer().copy(data, 40)
  data.writeBigUInt64LE(fields.tokens, 72)
  data.writeBigUInt64LE(fields.basis, 80)
  data.writeUInt8(fields.bump, 88)
  if (fields.autoExitDeadline !== null) data.writeBigInt64LE(fields.autoExitDeadline, 89)
  return data
}

type GetAccountInfoFn = (address: PublicKey) => Promise<AccountInfo<Buffer> | null>
interface ProgramAccount {
  readonly pubkey: PublicKey
  readonly account: AccountInfo<Buffer>
}
type GetProgramAccountsFn = (programId: PublicKey, config?: unknown) => Promise<readonly ProgramAccount[]>

const notMocked = async (): Promise<never> => {
  throw new Error('unexpected RPC call')
}

const mockConnection = (impl: { getAccountInfo?: GetAccountInfoFn; getProgramAccounts?: GetProgramAccountsFn }) => {
  const getAccountInfo = vi.fn<GetAccountInfoFn>(impl.getAccountInfo ?? notMocked)
  const getProgramAccounts = vi.fn<GetProgramAccountsFn>(impl.getProgramAccounts ?? notMocked)
  const connection = { getAccountInfo, getProgramAccounts } as unknown as Connection
  return { connection, getAccountInfo, getProgramAccounts }
}

const anchorAccountDiscriminator = (name: string): number[] => [
  ...createHash('sha256').update(`account:${name}`).digest().subarray(0, 8),
]

describe('discriminators used by the tests', () => {
  it('are sha256("account:<Name>")[..8]', () => {
    expect(anchorAccountDiscriminator('Market')).toEqual(MARKET_DISC)
    expect(anchorAccountDiscriminator('Position')).toEqual(POSITION_DISC)
  })
})

describe('decodeMarket', () => {
  it('decodes the devnet fixture to the golden values', () => {
    const data = devnetMarketData()
    expect(data.length).toBe(MARKET_ACCOUNT_SIZE)
    expect(DEVNET_MARKET.owner).toBe(ROUTER_PROGRAM_ID.toBase58())

    const market = decodeMarket(DEVNET_MARKET_ADDRESS, data)

    expect(market.address.toBase58()).toBe('4uLadxCZ1fgVoyr22ed79TakjiJmbaLHj53vqTntU1E5')
    expect(market.feeNumerator).toBe(10_000_000n)
    expect(market.bump).toBe(255)
    expect(market.totalBasis).toBe(347_013_193n)
    expect(market.finalized).toBe(true)
    expect(market.surplusSnapshot).toBe(43_449_744n)
    expect(market.basisSnapshot).toBe(347_013_193n)
    expect(market.surplusClaimed).toBe(43_449_742n)
    expect(market.pool.toBase58()).toBe('AkvNC8GhHJXpnNtBtZwJVnnXPxujyKBbTEek9HH36Er4')
    expect(market.quoteMint.toBase58()).toBe('So11111111111111111111111111111111111111112')
    expect(market.bufferVault.toBase58()).toBe('Af9d6u6N4L1arnKcvem13H3KD6v2s7pcAedX2ubHTjPE')
  })

  it('reads every field from its documented offset', () => {
    const market = decodeMarket(key(42), buildMarket(SAMPLE_MARKET))

    expect(market).toEqual({
      address: key(42),
      pool: key(1),
      config: key(2),
      baseMint: key(3),
      quoteMint: key(4),
      baseVault: key(5),
      quoteVault: key(6),
      bufferVault: key(7),
      feeNumerator: 25_000_000n,
      bump: 253,
      totalBasis: 18_446_744_073_709_551_615n,
      finalized: false,
      surplusSnapshot: 11n,
      basisSnapshot: 22n,
      surplusClaimed: 33n,
    })
  })

  it('returns a frozen object', () => {
    expect(Object.isFrozen(decodeMarket(key(42), buildMarket(SAMPLE_MARKET)))).toBe(true)
  })

  it('accepts accounts with appended fields from later versions', () => {
    const market = decodeMarket(key(42), buildMarket(SAMPLE_MARKET, MARKET_ACCOUNT_SIZE + 64))
    expect(market.surplusClaimed).toBe(33n)
  })

  it('accepts a plain Uint8Array view', () => {
    const data = devnetMarketData()
    const view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    expect(decodeMarket(DEVNET_MARKET_ADDRESS, view as Buffer).surplusClaimed).toBe(43_449_742n)
  })

  it('throws on a wrong discriminator', () => {
    const data = buildMarket(SAMPLE_MARKET)
    Buffer.from(POSITION_DISC).copy(data, 0)
    expect(() => decodeMarket(key(42), data)).toThrow(/discriminator/i)
  })

  it('throws when the data is shorter than the Market layout', () => {
    const data = buildMarket(SAMPLE_MARKET).subarray(0, MARKET_ACCOUNT_SIZE - 1)
    expect(() => decodeMarket(key(42), data)).toThrow(/274/)
  })

  it('throws when the data is shorter than a discriminator', () => {
    expect(() => decodeMarket(key(42), Buffer.from(MARKET_DISC.slice(0, 4)))).toThrow(/discriminator/i)
  })

  it('throws on an invalid bool in finalized', () => {
    expect(() => decodeMarket(key(42), buildMarket({ ...SAMPLE_MARKET, finalized: 2 }))).toThrow(/finalized/)
  })
})

describe('decodePosition', () => {
  it('decodes the 89-byte layout with a null auto-exit deadline', () => {
    const position = decodePosition(key(43), buildPosition(SAMPLE_POSITION))

    expect(position).toEqual({
      address: key(43),
      owner: key(9),
      market: key(10),
      tokens: 123_456_789_000n,
      basis: 987_654_321n,
      bump: 254,
      autoExitDeadline: null,
    })
    expect(Object.isFrozen(position)).toBe(true)
  })

  it('decodes the 97-byte layout with its auto-exit deadline', () => {
    const data = buildPosition({ ...SAMPLE_POSITION, autoExitDeadline: 1_791_763_200n })
    expect(data.length).toBe(POSITION_ACCOUNT_SIZE_V2)

    const position = decodePosition(key(43), data)

    expect(position.autoExitDeadline).toBe(1_791_763_200n)
    expect(position.tokens).toBe(123_456_789_000n)
  })

  it('keeps a zero (disabled) deadline as 0n and reads it as signed i64', () => {
    expect(decodePosition(key(43), buildPosition({ ...SAMPLE_POSITION, autoExitDeadline: 0n })).autoExitDeadline)
      .toBe(0n)
    expect(decodePosition(key(43), buildPosition({ ...SAMPLE_POSITION, autoExitDeadline: -1n })).autoExitDeadline)
      .toBe(-1n)
  })

  it('treats 90..96-byte data as the 89-byte layout', () => {
    expect(decodePosition(key(43), buildPosition(SAMPLE_POSITION, 96)).autoExitDeadline).toBeNull()
  })

  it('throws on a wrong discriminator', () => {
    const data = buildPosition(SAMPLE_POSITION)
    Buffer.from(MARKET_DISC).copy(data, 0)
    expect(() => decodePosition(key(43), data)).toThrow(/discriminator/i)
  })

  it('throws on Market data', () => {
    expect(() => decodePosition(key(43), buildMarket(SAMPLE_MARKET))).toThrow(/discriminator/i)
  })

  it('throws when the data is shorter than the Position layout', () => {
    const data = buildPosition(SAMPLE_POSITION).subarray(0, POSITION_ACCOUNT_SIZE_V1 - 1)
    expect(() => decodePosition(key(43), data)).toThrow(/89/)
  })
})

describe('fetchMarket', () => {
  it('resolves null when the account does not exist', async () => {
    const { connection, getAccountInfo } = mockConnection({ getAccountInfo: async () => null })

    await expect(fetchMarket(connection, DEVNET_MARKET_ADDRESS)).resolves.toBeNull()
    expect(getAccountInfo).toHaveBeenCalledTimes(1)
    expect(getAccountInfo).toHaveBeenCalledWith(DEVNET_MARKET_ADDRESS)
  })

  it('decodes an existing account', async () => {
    const { connection } = mockConnection({ getAccountInfo: async () => accountInfo(devnetMarketData()) })

    const market = await fetchMarket(connection, DEVNET_MARKET_ADDRESS)

    expect(market?.address.equals(DEVNET_MARKET_ADDRESS)).toBe(true)
    expect(market?.surplusClaimed).toBe(43_449_742n)
  })

  it('throws when the account is not a Market', async () => {
    const { connection } = mockConnection({ getAccountInfo: async () => accountInfo(buildPosition(SAMPLE_POSITION)) })

    await expect(fetchMarket(connection, key(43))).rejects.toThrow(/discriminator/i)
  })
})

describe('fetchAllMarkets', () => {
  const marketFilter = { memcmp: { offset: 0, bytes: Buffer.from(MARKET_DISC).toString('base64'), encoding: 'base64' } }

  it('queries the router with only the Market discriminator filter', async () => {
    const { connection, getProgramAccounts } = mockConnection({
      getProgramAccounts: async () => [
        { pubkey: DEVNET_MARKET_ADDRESS, account: accountInfo(devnetMarketData()) },
        { pubkey: key(42), account: accountInfo(buildMarket(SAMPLE_MARKET, MARKET_ACCOUNT_SIZE + 8)) },
      ],
    })

    const markets = await fetchAllMarkets(connection)

    expect(getProgramAccounts).toHaveBeenCalledTimes(1)
    expect(getProgramAccounts).toHaveBeenCalledWith(ROUTER_PROGRAM_ID, { filters: [marketFilter] })
    expect(markets.map((m) => m.address.toBase58())).toEqual([DEVNET_MARKET.address, key(42).toBase58()])
    expect(markets[1]?.feeNumerator).toBe(25_000_000n)
  })

  it('uses the given router program id', async () => {
    const programId = key(77)
    const { connection, getProgramAccounts } = mockConnection({ getProgramAccounts: async () => [] })

    await expect(fetchAllMarkets(connection, programId)).resolves.toEqual([])
    expect(getProgramAccounts).toHaveBeenCalledWith(programId, { filters: [marketFilter] })
  })
})

describe('fetchPositionsByOwner', () => {
  it('queries the router with the Position discriminator and owner filters', async () => {
    const owner = SAMPLE_POSITION.owner
    const { connection, getProgramAccounts } = mockConnection({
      getProgramAccounts: async () => [
        { pubkey: key(43), account: accountInfo(buildPosition(SAMPLE_POSITION)) },
        { pubkey: key(44), account: accountInfo(buildPosition({ ...SAMPLE_POSITION, autoExitDeadline: 5n })) },
      ],
    })

    const positions = await fetchPositionsByOwner(connection, owner)

    expect(getProgramAccounts).toHaveBeenCalledTimes(1)
    expect(getProgramAccounts).toHaveBeenCalledWith(ROUTER_PROGRAM_ID, {
      filters: [
        { memcmp: { offset: 0, bytes: Buffer.from(POSITION_DISC).toString('base64'), encoding: 'base64' } },
        { memcmp: { offset: 8, bytes: owner.toBase58() } },
      ],
    })
    expect(positions.map((p) => [p.address.toBase58(), p.autoExitDeadline])).toEqual([
      [key(43).toBase58(), null],
      [key(44).toBase58(), 5n],
    ])
  })

  it('uses the given router program id', async () => {
    const programId = key(77)
    const { connection, getProgramAccounts } = mockConnection({ getProgramAccounts: async () => [] })

    await expect(fetchPositionsByOwner(connection, key(9), programId)).resolves.toEqual([])
    expect(getProgramAccounts.mock.calls[0]?.[0]).toBe(programId)
  })
})

describe('marketAccountsFor', () => {
  it('copies the market addresses and adds the quote token program', () => {
    const market = decodeMarket(DEVNET_MARKET_ADDRESS, devnetMarketData())

    const accounts = marketAccountsFor(market, TOKEN_PROGRAM_ID)

    expect(accounts).toEqual({
      market: market.address,
      pool: market.pool,
      config: market.config,
      baseMint: market.baseMint,
      quoteMint: market.quoteMint,
      baseVault: market.baseVault,
      quoteVault: market.quoteVault,
      bufferVault: market.bufferVault,
      quoteTokenProgram: TOKEN_PROGRAM_ID,
    })
    expect(Object.isFrozen(accounts)).toBe(true)
  })
})
