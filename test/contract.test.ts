/**
 * Public API contract of @trucee/sdk (SDK-05). Pins the exported surface, the constants mirrored from
 * zpvp/programs/*, and the frozen error tables. Behaviour tests live with each implementing task.
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import * as sdk from '../src/index.js'
import type { RouterEvent } from '../src/index.js'

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

const anchorDiscriminator = (namespace: string, name: string): string =>
  createHash('sha256').update(`${namespace}:${name}`).digest().subarray(0, 8).toString('hex')

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
  it('router errors are contiguous from 6000 and keep 6000..6018 in enum order', () => {
    const codes = Object.keys(sdk.ROUTER_ERRORS).map(Number).sort((a, b) => a - b)
    expect(codes.length).toBeGreaterThanOrEqual(ROUTER_ERROR_NAMES.length)
    expect(codes).toEqual(codes.map((_, i) => 6000 + i))
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
    expect(sdk.HOOK_ERRORS[6001]).toBeUndefined()
  })
})
