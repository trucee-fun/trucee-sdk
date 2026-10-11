/**
 * SDK-01 addressing layer: getClusterConfig (program ids, quote mints per cluster) and the router/hook PDAs.
 * Golden PDAs come from the devnet v4 e2e run (litesvm-diff/out/e2e_devnet_v4.json).
 */
import { Buffer } from 'buffer'
import { Keypair, PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import {
  DBC_PROGRAM_ID,
  HOOK_PROGRAM_ID,
  ROUTER_PROGRAM_ID,
  findBufferPda,
  findExtraAccountMetasPda,
  findMarketPda,
  findPositionPda,
  getClusterConfig,
} from '../src/index.js'
import type { Cluster, QuoteMintInfo } from '../src/index.js'

const ROUTER = 'D4sk6wwELD6cmd7tv6hE4hkxQP8SF8tjdegYym8iWNNb'
const HOOK = 'CUNNV1MqVB53N4jWn91uVFXm1dBSyaynR6iBCbufJWMS'
const DBC = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN'
const SPL_TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'

interface ExpectedQuote {
  readonly symbol: QuoteMintInfo['symbol']
  readonly mint: string
  readonly decimals: number
  readonly tokenProgram: string
  readonly maxMigrationQuoteThreshold: bigint
  readonly tokenBadge: string | null
}

const SOL: ExpectedQuote = {
  symbol: 'SOL',
  mint: 'So11111111111111111111111111111111111111112',
  decimals: 9,
  tokenProgram: SPL_TOKEN,
  maxMigrationQuoteThreshold: 10_000_000_000n,
  tokenBadge: null,
}
const TSLAX: ExpectedQuote = {
  symbol: 'TSLAx',
  mint: 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB',
  decimals: 8,
  tokenProgram: TOKEN_2022,
  maxMigrationQuoteThreshold: 500_000_000n,
  tokenBadge: 'XhM8atXDua58KZnZFLu5vJjzaNWjXaEvpPPEVnHn1ax',
}
const NVDAX: ExpectedQuote = {
  symbol: 'NVDAx',
  mint: 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh',
  decimals: 8,
  tokenProgram: TOKEN_2022,
  maxMigrationQuoteThreshold: 1_000_000_000n,
  tokenBadge: 'mfacWnGh1Kn5ttHMMaNZhRZbCjvGrDQyDyZgqaR9vBM',
}

const EXPECTED_QUOTES: Readonly<Record<Cluster, readonly ExpectedQuote[]>> = {
  devnet: [SOL],
  'mainnet-beta': [SOL, TSLAX, NVDAX],
  localnet: [SOL, TSLAX, NVDAX],
}
const CLUSTERS = Object.keys(EXPECTED_QUOTES) as Cluster[]

const asPlain = (quote: QuoteMintInfo): ExpectedQuote => ({
  symbol: quote.symbol,
  mint: quote.mint.toBase58(),
  decimals: quote.decimals,
  tokenProgram: quote.tokenProgram.toBase58(),
  maxMigrationQuoteThreshold: quote.maxMigrationQuoteThreshold,
  tokenBadge: quote.tokenBadge === null ? null : quote.tokenBadge.toBase58(),
})

/** Devnet v4 e2e run (litesvm-diff/out/e2e_devnet_v4.json). */
const GOLDEN = {
  pool: new PublicKey('AkvNC8GhHJXpnNtBtZwJVnnXPxujyKBbTEek9HH36Er4'),
  market: '4uLadxCZ1fgVoyr22ed79TakjiJmbaLHj53vqTntU1E5',
  buffer: 'Af9d6u6N4L1arnKcvem13H3KD6v2s7pcAedX2ubHTjPE',
  baseMint: new PublicKey('HXrGNcXu9tRJMC18Rd8fd714SaL3rcKGbfonie2a2iNS'),
  extraAccountMetas: 'Aci7az7FZdWLnx473g1TKq87FJUZ4HDfDWw4zJB62YUi',
} as const

const keyFrom = (seed: number): PublicKey => Keypair.fromSeed(new Uint8Array(32).fill(seed)).publicKey

describe('getClusterConfig', () => {
  it.each(CLUSTERS)('%s uses the deployed router, hook and DBC program ids', (cluster) => {
    const config = getClusterConfig(cluster)
    expect(config.cluster).toBe(cluster)
    expect(config.routerProgramId.toBase58()).toBe(ROUTER)
    expect(config.hookProgramId.toBase58()).toBe(HOOK)
    expect(config.dbcProgramId.toBase58()).toBe(DBC)
    expect(config.routerProgramId.equals(ROUTER_PROGRAM_ID)).toBe(true)
    expect(config.hookProgramId.equals(HOOK_PROGRAM_ID)).toBe(true)
    expect(config.dbcProgramId.equals(DBC_PROGRAM_ID)).toBe(true)
  })

  it.each(CLUSTERS)('%s lists exactly its quote mints, in order', (cluster) => {
    expect(getClusterConfig(cluster).quoteMints.map(asPlain)).toEqual(EXPECTED_QUOTES[cluster])
  })

  it('devnet is SOL-only', () => {
    expect(getClusterConfig('devnet').quoteMints.map((quote) => quote.symbol)).toEqual(['SOL'])
  })

  it('localnet mirrors mainnet-beta quote mints (xStocks via mainnet fixtures)', () => {
    expect(getClusterConfig('localnet').quoteMints.map(asPlain))
      .toEqual(getClusterConfig('mainnet-beta').quoteMints.map(asPlain))
  })

  it('xStock quotes are Token-2022 with a DBC token badge; SOL has none', () => {
    const quotes = getClusterConfig('mainnet-beta').quoteMints
    quotes.filter((quote) => quote.symbol !== 'SOL').forEach((quote) => {
      expect(quote.tokenProgram.toBase58()).toBe(TOKEN_2022)
      expect(quote.tokenBadge).not.toBeNull()
    })
    expect(quotes.find((quote) => quote.symbol === 'SOL')?.tokenBadge).toBeNull()
  })

  it.each(CLUSTERS)('%s config, its quote list and each quote are frozen', (cluster) => {
    const config = getClusterConfig(cluster)
    expect(Object.isFrozen(config)).toBe(true)
    expect(Object.isFrozen(config.quoteMints)).toBe(true)
    config.quoteMints.forEach((quote) => expect(Object.isFrozen(quote)).toBe(true))
  })

  it('rejects mutation attempts', () => {
    const config = getClusterConfig('devnet')
    expect(() => {
      (config as { cluster: string }).cluster = 'mainnet-beta'
    }).toThrow(TypeError)
    expect(() => {
      (config.quoteMints as QuoteMintInfo[]).push(config.quoteMints[0] as QuoteMintInfo)
    }).toThrow(TypeError)
    expect(getClusterConfig('devnet').cluster).toBe('devnet')
    expect(getClusterConfig('devnet').quoteMints).toHaveLength(1)
  })

  it.each(['testnet', '', 'Devnet', 'mainnet', 'toString', '__proto__', 'constructor'])(
    'throws a clear error on unknown cluster %j',
    (cluster) => {
      expect(() => getClusterConfig(cluster as Cluster)).toThrow(/Unknown cluster/)
      expect(() => getClusterConfig(cluster as Cluster)).toThrow(/devnet, mainnet-beta, localnet/)
    },
  )

  it.each([undefined, null, 42, {}])('throws a clear error on non-string cluster %j', (cluster) => {
    expect(() => getClusterConfig(cluster as unknown as Cluster)).toThrow(/Unknown cluster/)
  })
})

describe('router and hook PDAs (devnet v4 golden)', () => {
  it('market = ["market", pool] under the router', () => {
    expect(findMarketPda(GOLDEN.pool).toBase58()).toBe(GOLDEN.market)
  })

  it('buffer = ["buffer", market] under the router', () => {
    expect(findBufferPda(new PublicKey(GOLDEN.market)).toBase58()).toBe(GOLDEN.buffer)
  })

  it('extra account metas = ["extra-account-metas", baseMint] under the hook', () => {
    expect(findExtraAccountMetasPda(GOLDEN.baseMint).toBase58()).toBe(GOLDEN.extraAccountMetas)
  })

  it('chains pool -> market -> buffer', () => {
    expect(findBufferPda(findMarketPda(GOLDEN.pool)).toBase58()).toBe(GOLDEN.buffer)
  })
})

describe('findPositionPda', () => {
  const market = new PublicKey(GOLDEN.market)
  const owner = keyFrom(7)

  it('= ["position", market, owner] under the router', () => {
    const [expected] = PublicKey.findProgramAddressSync(
      [Buffer.from('position'), market.toBuffer(), owner.toBuffer()],
      new PublicKey(ROUTER),
    )
    expect(findPositionPda(market, owner).equals(expected)).toBe(true)
  })

  it('is order-sensitive and unique per owner and market', () => {
    const position = findPositionPda(market, owner)
    expect(findPositionPda(owner, market).equals(position)).toBe(false)
    expect(findPositionPda(market, keyFrom(8)).equals(position)).toBe(false)
    expect(findPositionPda(keyFrom(9), owner).equals(position)).toBe(false)
  })

  it('is deterministic and off-curve', () => {
    const position = findPositionPda(market, owner)
    expect(findPositionPda(market, owner).equals(position)).toBe(true)
    expect(PublicKey.isOnCurve(position.toBytes())).toBe(false)
  })
})

describe('program id overrides', () => {
  const otherProgram = keyFrom(1)

  it('router PDAs follow the given router program id', () => {
    const [expectedMarket] = PublicKey.findProgramAddressSync([Buffer.from('market'), GOLDEN.pool.toBuffer()], otherProgram)
    expect(findMarketPda(GOLDEN.pool, otherProgram).equals(expectedMarket)).toBe(true)
    expect(findMarketPda(GOLDEN.pool, otherProgram).toBase58()).not.toBe(GOLDEN.market)
    expect(findBufferPda(new PublicKey(GOLDEN.market), otherProgram).toBase58()).not.toBe(GOLDEN.buffer)
    expect(findPositionPda(new PublicKey(GOLDEN.market), keyFrom(7), otherProgram)
      .equals(findPositionPda(new PublicKey(GOLDEN.market), keyFrom(7)))).toBe(false)
  })

  it('extra account metas follow the given hook program id', () => {
    expect(findExtraAccountMetasPda(GOLDEN.baseMint, otherProgram).toBase58()).not.toBe(GOLDEN.extraAccountMetas)
  })
})

describe('input validation', () => {
  const notAKey = GOLDEN.pool.toBase58() as unknown as PublicKey

  it.each([
    ['findMarketPda', () => findMarketPda(notAKey)],
    ['findBufferPda', () => findBufferPda(notAKey)],
    ['findPositionPda (market)', () => findPositionPda(notAKey, GOLDEN.pool)],
    ['findPositionPda (owner)', () => findPositionPda(GOLDEN.pool, notAKey)],
    ['findExtraAccountMetasPda', () => findExtraAccountMetasPda(notAKey)],
    ['findMarketPda (program id)', () => findMarketPda(GOLDEN.pool, notAKey)],
    ['findMarketPda (undefined)', () => findMarketPda(undefined as unknown as PublicKey)],
  ])('%s rejects a non-PublicKey with a TypeError', (_name, call) => {
    expect(call).toThrow(TypeError)
    expect(call).toThrow(/must be a PublicKey/)
  })

  it('rejects a key-like value that is not 32 bytes', () => {
    const short = { toBytes: () => new Uint8Array(31) } as unknown as PublicKey
    expect(() => findMarketPda(short)).toThrow(/pool must be a PublicKey of 32 bytes, got 31/)
  })

  it('accepts a PublicKey from another @solana/web3.js copy (duck-typed)', () => {
    const foreignPool = { toBytes: () => GOLDEN.pool.toBytes() } as unknown as PublicKey
    expect(findMarketPda(foreignPool).toBase58()).toBe(GOLDEN.market)
  })
})
