/**
 * Public API contract of @trucee/sdk (SDK-05). Pins the exported surface, the constants mirrored from
 * zpvp/programs/*, and the scaffold rule that an unimplemented function throws `not implemented: <name>`.
 */
import { createHash } from 'node:crypto'
import { Connection, Keypair, type PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import * as sdk from '../src/index.js'
import type {
  ClusterConfig, MarketAccount, MarketAccounts, PositionAccount, PresetOptions, QuoteMintInfo, RouterEvent,
} from '../src/index.js'

const EXPORTED_FUNCTIONS = [
  'getClusterConfig',
  'findMarketPda', 'findBufferPda', 'findPositionPda', 'findExtraAccountMetasPda',
  'decodeMarket', 'decodePosition', 'fetchMarket', 'fetchAllMarkets', 'fetchPositionsByOwner', 'marketAccountsFor',
  'parseRouterEvents',
  'buyInstructions', 'sellInstructions', 'finalizeInstruction', 'claimSurplusInstruction', 'initMarketInstruction',
  'initExtraAccountMetasInstruction',
  'buildZeroPvpConfigParameters', 'buildLaunchPlan',
  'refundFor', 'basisForExit', 'floorValue', 'quoteExit', 'quoteBuy',
  'decodeTxError',
] as const

const EVENT_NAMES: readonly RouterEvent['name'][] = ['BuyEvent', 'SellEvent', 'ClaimEvent', 'FinalizeEvent']

/** RouterError in zpvp/programs/zpvp_router/src/lib.rs, enum order from 6000. */
const ROUTER_ERROR_NAMES = [
  'NotDbcAccount', 'NotTransferHookPool', 'NotTransferHookConfig', 'BadHookAccounts', 'PoolConfigMismatch',
  'MintMismatch', 'ZeroOutput', 'InvalidExitAmount', 'MathOverflow', 'CurveNotComplete', 'AlreadyFinalized',
  'NotFinalized', 'NotPositionOwner', 'WrongTransferHook', 'UnsupportedFeeConfig', 'BufferInsufficient',
  'SurplusOverclaimed', 'QuoteMintNotAllowed', 'ThresholdTooHigh',
] as const

const pk = (): PublicKey => Keypair.generate().publicKey
const anchorDiscriminator = (namespace: string, name: string): string =>
  createHash('sha256').update(`${namespace}:${name}`).digest().subarray(0, 8).toString('hex')

// --- placeholder arguments for stub calls (never sent anywhere)
const connection = new Connection('http://127.0.0.1:1')
const cluster: ClusterConfig = {
  cluster: 'localnet',
  routerProgramId: sdk.ROUTER_PROGRAM_ID,
  hookProgramId: sdk.HOOK_PROGRAM_ID,
  dbcProgramId: sdk.DBC_PROGRAM_ID,
  quoteMints: [],
}
const quote: QuoteMintInfo = {
  symbol: 'SOL', mint: pk(), decimals: 9, tokenProgram: pk(), maxMigrationQuoteThreshold: 10_000_000_000n, tokenBadge: null,
}
const market: MarketAccount = {
  address: pk(), pool: pk(), config: pk(), baseMint: pk(), quoteMint: pk(), baseVault: pk(), quoteVault: pk(),
  bufferVault: pk(), feeNumerator: 10_000_000n, bump: 255, totalBasis: 0n, finalized: false, surplusSnapshot: 0n,
  basisSnapshot: 0n, surplusClaimed: 0n,
}
const position: PositionAccount = {
  address: pk(), owner: pk(), market: market.address, tokens: 1_000n, basis: 984n, bump: 254, autoExitDeadline: null,
}
const accounts: MarketAccounts = {
  market: market.address, pool: market.pool, config: market.config, baseMint: market.baseMint, quoteMint: market.quoteMint,
  baseVault: market.baseVault, quoteVault: market.quoteVault, bufferVault: market.bufferVault, quoteTokenProgram: pk(),
}
const preset: PresetOptions = {
  quote, migrationQuoteThreshold: 10_000_000_000n, feeBps: 100, feeClaimer: pk(), leftoverReceiver: pk(),
}
const user = pk()

type StubCall = readonly [name: (typeof EXPORTED_FUNCTIONS)[number], call: () => unknown]

/**
 * Functions still stubbed, grouped by source file. The task that implements a file empties its group here
 * (and adds its own behaviour tests); groups are kept apart so parallel tasks do not collide.
 */
const STUBS: Readonly<Record<string, readonly StubCall[]>> = {
  constants: [
    ['getClusterConfig', () => sdk.getClusterConfig('devnet')],
  ],

  pda: [
    ['findMarketPda', () => sdk.findMarketPda(market.pool)],
    ['findBufferPda', () => sdk.findBufferPda(market.address)],
    ['findPositionPda', () => sdk.findPositionPda(market.address, user)],
    ['findExtraAccountMetasPda', () => sdk.findExtraAccountMetasPda(market.baseMint)],
  ],

  accounts: [
    ['decodeMarket', () => sdk.decodeMarket(market.address, Buffer.alloc(sdk.MARKET_ACCOUNT_SIZE))],
    ['decodePosition', () => sdk.decodePosition(position.address, Buffer.alloc(sdk.POSITION_ACCOUNT_SIZE_V2))],
    ['fetchMarket', () => sdk.fetchMarket(connection, market.address)],
    ['fetchAllMarkets', () => sdk.fetchAllMarkets(connection)],
    ['fetchPositionsByOwner', () => sdk.fetchPositionsByOwner(connection, user)],
    ['marketAccountsFor', () => sdk.marketAccountsFor(market, accounts.quoteTokenProgram)],
  ],

  events: [
    ['parseRouterEvents', () => sdk.parseRouterEvents([])],
  ],

  instructions: [
    ['buyInstructions', () => sdk.buyInstructions({ cluster, accounts, user, amountIn: 1n, minOut: 0n })],
    ['sellInstructions', () => sdk.sellInstructions({ cluster, accounts, user, tokens: 1n, unwrapSol: true })],
    ['finalizeInstruction', () => sdk.finalizeInstruction({
      cluster, market: market.address, pool: market.pool, bufferVault: market.bufferVault,
    })],
    ['claimSurplusInstruction', () => sdk.claimSurplusInstruction({ cluster, accounts, cranker: user, owner: position.owner })],
    ['initMarketInstruction', () => sdk.initMarketInstruction({
      cluster, payer: user, pool: market.pool, config: market.config, quoteMint: market.quoteMint,
      quoteTokenProgram: accounts.quoteTokenProgram,
    })],
    ['initExtraAccountMetasInstruction', () => sdk.initExtraAccountMetasInstruction(user, market.baseMint)],
  ],

  launch: [
    ['buildZeroPvpConfigParameters', () => sdk.buildZeroPvpConfigParameters(preset)],
    ['buildLaunchPlan', () => sdk.buildLaunchPlan({
      connection, cluster, creator: user, name: 'Trucee', symbol: 'TRU', uri: 'https://example.invalid/t.json', preset,
    })],
  ],

  quote: [
    ['refundFor', () => sdk.refundFor(1_000_000_000n, 10_000_000n)],
    ['basisForExit', () => sdk.basisForExit(3n, 10n, 1n)],
    ['floorValue', () => sdk.floorValue(position, market)],
    ['quoteExit', () => sdk.quoteExit(position, market, 1n)],
    ['quoteBuy', () => sdk.quoteBuy(connection, market, 1n)],
  ],

  errors: [
    ['decodeTxError', () => sdk.decodeTxError(new Error('boom'))],
  ],
}

describe('exports', () => {
  it.each(EXPORTED_FUNCTIONS)('%s is an exported function', (name) => {
    expect(typeof (sdk as Record<string, unknown>)[name]).toBe('function')
  })
})

describe('constants', () => {
  it('program ids match the deployed programs', () => {
    expect(sdk.ROUTER_PROGRAM_ID.toBase58()).toBe('D4sk6wwELD6cmd7tv6hE4hkxQP8SF8tjdegYym8iWNNb')
    expect(sdk.HOOK_PROGRAM_ID.toBase58()).toBe('CUNNV1MqVB53N4jWn91uVFXm1dBSyaynR6iBCbufJWMS')
    expect(sdk.DBC_PROGRAM_ID.toBase58()).toBe('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN')
  })

  it('refund accounting constants mirror zpvp_router math.rs', () => {
    expect(sdk.FEE_DENOMINATOR).toBe(1_000_000_000n)
    expect(sdk.DUST_PER_BUY).toBe(16n)
    expect(sdk.HAIRCUT_PER_EXIT).toBe(2n)
  })

  it('account sizes match the borsh layouts (8-byte discriminator included)', () => {
    expect(sdk.MARKET_ACCOUNT_SIZE).toBe(274)
    expect(sdk.MARKET_ACCOUNT_SIZE).toBe(8 + 7 * 32 + 8 + 1 + 8 + 1 + 8 + 8 + 8)
    expect(sdk.POSITION_ACCOUNT_SIZE_V1).toBe(89)
    expect(sdk.POSITION_ACCOUNT_SIZE_V1).toBe(8 + 32 + 32 + 8 + 8 + 1)
    expect(sdk.POSITION_ACCOUNT_SIZE_V2).toBe(97)
    expect(sdk.POSITION_ACCOUNT_SIZE_V2).toBe(sdk.POSITION_ACCOUNT_SIZE_V1 + 8)
  })
})

describe('event discriminators', () => {
  it('cover exactly the four router events', () => {
    expect(Object.keys(sdk.EVENT_DISCRIMINATORS).sort()).toEqual([...EVENT_NAMES].sort())
    expect(Object.isFrozen(sdk.EVENT_DISCRIMINATORS)).toBe(true)
  })

  it.each(EVENT_NAMES)('%s = sha256("event:<Name>")[..8]', (name) => {
    const discriminator = sdk.EVENT_DISCRIMINATORS[name]
    expect(discriminator).toHaveLength(8)
    expect(discriminator.toString('hex')).toBe(anchorDiscriminator('event', name))
  })

  it('pins BuyEvent bytes', () => {
    expect([...sdk.EVENT_DISCRIMINATORS.BuyEvent]).toEqual([103, 244, 82, 31, 44, 245, 119, 119])
  })
})

describe('program errors', () => {
  it('router errors are 6000..6018 in enum order', () => {
    const codes = Object.keys(sdk.ROUTER_ERRORS).map(Number).sort((a, b) => a - b)
    expect(codes).toEqual(ROUTER_ERROR_NAMES.map((_, i) => 6000 + i))
    ROUTER_ERROR_NAMES.forEach((name, i) => expect(sdk.ROUTER_ERRORS[6000 + i]?.name).toBe(name))
    expect(Object.isFrozen(sdk.ROUTER_ERRORS)).toBe(true)
  })

  it('router error messages match the #[msg] strings', () => {
    expect(sdk.ROUTER_ERRORS[6000]).toEqual({ name: 'NotDbcAccount', message: 'Account is not owned by the DBC program' })
    expect(sdk.ROUTER_ERRORS[6007]).toEqual({ name: 'InvalidExitAmount', message: 'Exit amount must be > 0 and <= position' })
    expect(sdk.ROUTER_ERRORS[6015]).toEqual({ name: 'BufferInsufficient', message: 'Buffer cannot cover the refund' })
    expect(sdk.ROUTER_ERRORS[6018]).toEqual({
      name: 'ThresholdTooHigh', message: 'Mainnet beta: migration quote threshold above the cap',
    })
  })

  it('hook has a single error 6000 TransferNotViaRouter', () => {
    expect(sdk.HOOK_ERRORS).toEqual({
      6000: { name: 'TransferNotViaRouter', message: 'Pre-graduation transfers must go through the Zero-PvP router' },
    })
    expect(Object.isFrozen(sdk.HOOK_ERRORS)).toBe(true)
  })

  it('unknown codes are absent', () => {
    expect(sdk.ROUTER_ERRORS[6019]).toBeUndefined()
    expect(sdk.HOOK_ERRORS[6001]).toBeUndefined()
  })
})

describe('stubs', () => {
  const pending = Object.values(STUBS).flat()

  it.each(pending)('%s throws "not implemented: <name>"', async (name, call) => {
    // async stubs reject; sync stubs throw before a promise exists
    await expect(async () => call()).rejects.toThrow(new RegExp(`^not implemented: ${name}$`))
  })
})
