/**
 * SDK-08: decodeTxError maps failed transactions (router, hook, DBC, Anchor framework, wallet) to DecodedTxError.
 */
import { SendTransactionError } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { HOOK_ERRORS, ROUTER_ERRORS, decodeTxError } from '../src/errors.js'

const ROUTER = 'D4sk6wwELD6cmd7tv6hE4hkxQP8SF8tjdegYym8iWNNb'
const HOOK = 'CUNNV1MqVB53N4jWn91uVFXm1dBSyaynR6iBCbufJWMS'
const DBC = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN'
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'

const hex = (code: number): string => `0x${code.toString(16)}`
const failedLine = (program: string, code: number): string =>
  `Program ${program} failed: custom program error: ${hex(code)}`

/** Logs of a router instruction that fails in its own code with `code`. */
const routerFailureLogs = (code: number, name: string): string[] => [
  'Program ComputeBudget111111111111111111111111111111 invoke [1]',
  'Program ComputeBudget111111111111111111111111111111 success',
  `Program ${ROUTER} invoke [1]`,
  'Program log: Instruction: Buy',
  `Program log: AnchorError thrown in programs/zpvp_router/src/lib.rs:120. Error Code: ${name}. Error Number: ${code}.`,
  `Program ${ROUTER} consumed 21000 of 200000 compute units`,
  failedLine(ROUTER, code),
]

/** Logs of a router buy whose DBC swap CPI fails with `code`: the innermost (DBC) failure is logged first. */
const dbcInsideRouterLogs = (code: number, name: string): string[] => [
  `Program ${ROUTER} invoke [1]`,
  'Program log: Instruction: Buy',
  `Program ${DBC} invoke [2]`,
  'Program log: Instruction: Swap2',
  `Program log: AnchorError thrown in programs/dynamic-bonding-curve/src/instructions/swap/process_swap.rs:224. Error Code: ${name}. Error Number: ${code}.`,
  `Program ${DBC} consumed 14053 of 180000 compute units`,
  failedLine(DBC, code),
  `Program ${ROUTER} consumed 40000 of 200000 compute units`,
  failedLine(ROUTER, code),
]

/** Logs of a direct transfer blocked by the hook, nested in Token-2022: the hook line comes first. */
const HOOK_BLOCKED_LOGS = [
  `Program ${TOKEN_2022} invoke [1]`,
  'Program log: Instruction: TransferChecked',
  `Program ${HOOK} invoke [2]`,
  'Program log: Instruction: Execute',
  'Program log: AnchorError occurred. Error Code: TransferNotViaRouter. Error Number: 6000.',
  `Program ${HOOK} consumed 5000 of 190000 compute units`,
  `Program ${HOOK} failed: custom program error: 0x1770`,
  `Program ${TOKEN_2022} consumed 9000 of 200000 compute units`,
  `Program ${TOKEN_2022} failed: custom program error: 0x1770`,
]

/** Verbatim LiteSVM error string from litesvm-diff/out (DBC PoolIsCompleted inside a router buy). */
const LITESVM_POOL_COMPLETED =
  'TransactionErrorInstructionError { index: 2, error: InstructionErrorCustom { code: 6013 } } :: ' +
  'Program log: AnchorError thrown in programs/dynamic-bonding-curve/src/instructions/swap/process_swap.rs:224. ' +
  'Error Code: PoolIsCompleted. Error Number: 6013. Error Message: Pool is completed. | ' +
  'Program dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN failed: custom program error: 0x177d | ' +
  'Program D4sk6wwELD6cmd7tv6hE4hkxQP8SF8tjdegYym8iWNNb failed: custom program error: 0x177d'

const simulationError = (logs: string[] | undefined, instructionCode: number): SendTransactionError =>
  new SendTransactionError({
    action: 'simulate',
    signature: '',
    transactionMessage: `Transaction simulation failed: Error processing Instruction 1: custom program error: ${hex(instructionCode)}`,
    logs,
  })

/** Shape of @solana/wallet-adapter-base errors (WalletError keeps the cause in `.error`). */
class FakeWalletError extends Error {
  constructor(name: string, message: string, readonly error?: unknown) {
    super(message)
    this.name = name
  }
}

describe('ROUTER_ERRORS v5 additions', () => {
  it('6019..6021 mirror the auto-exit #[msg] strings in lib.rs', () => {
    expect(ROUTER_ERRORS[6019]).toEqual({
      name: 'AutoExitDeadlineInPast', message: 'Auto-exit deadline must be in the future (or 0 to clear)',
    })
    expect(ROUTER_ERRORS[6020]).toEqual({
      name: 'AutoExitNotDue', message: 'Auto-exit deadline not reached (or auto-exit not set)',
    })
    expect(ROUTER_ERRORS[6021]).toEqual({
      name: 'AutoExitCurveComplete', message: 'Curve is complete: auto-exit is no longer possible',
    })
  })

  it('6022 PositionCapExceeded and 6023 PresetNotAllowed match the ONC-04 / ONC-14 #[msg] strings', () => {
    expect(ROUTER_ERRORS[6022]).toEqual({
      name: 'PositionCapExceeded', message: 'Buy would exceed the anti-whale cap (20% of curve supply)',
    })
    expect(ROUTER_ERRORS[6023]).toEqual({
      name: 'PresetNotAllowed',
      message: 'Config breaks the Zero-PvP preset (creator allocation, fixed supply or unlocked LP)',
    })
    expect(Object.keys(ROUTER_ERRORS)).toHaveLength(25)
  })

  it('6024 FeeTooHigh matches the router fee cap message', () => {
    expect(ROUTER_ERRORS[6024]).toEqual({
      name: 'FeeTooHigh', message: 'Config fee is above the 1% cap',
    })
  })

  it('the hook table is unchanged', () => {
    expect(Object.keys(HOOK_ERRORS)).toEqual(['6000'])
  })
})

describe('decodeTxError: router errors from logs', () => {
  it.each([
    [6017, 'QuoteMintNotAllowed'],
    [6018, 'ThresholdTooHigh'],
    [6022, 'PositionCapExceeded'],
    [6024, 'FeeTooHigh'],
    [6007, 'InvalidExitAmount'],
  ])('router %i decodes as %s', (code, name) => {
    const decoded = decodeTxError(simulationError(routerFailureLogs(code, name), code))
    expect(decoded).toEqual({ program: 'router', code, name, message: ROUTER_ERRORS[code]?.message })
  })

  it('an Anchor constraint failing in the router keeps the router attribution', () => {
    const decoded = decodeTxError({ logs: [`Program ${ROUTER} invoke [1]`, failedLine(ROUTER, 2006)] })
    expect(decoded).toEqual({
      program: 'router', code: 2006, name: 'ConstraintSeeds', message: 'A seeds constraint was violated',
    })
  })

  it('a router code missing from the table still decodes as a router CustomProgramError', () => {
    const decoded = decodeTxError({ logs: [failedLine(ROUTER, 6100)] })
    expect(decoded).toMatchObject({ program: 'router', code: 6100, name: 'CustomProgramError' })
  })
})

describe('decodeTxError: hook', () => {
  it('attributes the hook 6000 to the hook, not to router 6000 NotDbcAccount', () => {
    const decoded = decodeTxError(simulationError(HOOK_BLOCKED_LOGS, 6000))
    expect(decoded).toEqual({
      program: 'hook',
      code: 6000,
      name: 'TransferNotViaRouter',
      message: 'Pre-graduation transfers must go through the Zero-PvP router',
    })
  })

  it('decodes the hook line inside a single log string', () => {
    const decoded = decodeTxError(`Program ${HOOK} failed: custom program error: 0x1770`)
    expect(decoded).toMatchObject({ program: 'hook', code: 6000, name: 'TransferNotViaRouter' })
  })
})

describe('decodeTxError: DBC errors use the innermost failure', () => {
  it('slippage inside a router buy decodes as DBC ExceededSlippage', () => {
    const decoded = decodeTxError(simulationError(dbcInsideRouterLogs(6002, 'ExceededSlippage'), 6002))
    expect(decoded).toEqual({
      program: 'dbc', code: 6002, name: 'ExceededSlippage', message: 'Exceeded slippage tolerance',
    })
  })

  it('a completed pool inside a router buy decodes as DBC PoolIsCompleted, not router WrongTransferHook', () => {
    const decoded = decodeTxError({ logs: dbcInsideRouterLogs(6013, 'PoolIsCompleted') })
    expect(decoded).toEqual({ program: 'dbc', code: 6013, name: 'PoolIsCompleted', message: 'Pool is completed' })
  })

  it('decodes the LiteSVM error string from litesvm-diff', () => {
    expect(decodeTxError(LITESVM_POOL_COMPLETED)).toEqual({
      program: 'dbc', code: 6013, name: 'PoolIsCompleted', message: 'Pool is completed',
    })
  })

  it('decodes a LiteSVM error string carried as an Error message', () => {
    expect(decodeTxError(new Error(LITESVM_POOL_COMPLETED))).toMatchObject({ program: 'dbc', name: 'PoolIsCompleted' })
  })

  it('reads the inner SendTransactionError of a wallet-adapter send error', () => {
    const inner = simulationError(dbcInsideRouterLogs(6002, 'ExceededSlippage'), 6002)
    const outer = new FakeWalletError('WalletSendTransactionError', inner.message, inner)
    expect(decodeTxError(outer)).toMatchObject({ program: 'dbc', code: 6002, name: 'ExceededSlippage' })
  })
})

describe('decodeTxError: bare codes without logs', () => {
  it.each([
    [2006, 'ConstraintSeeds', 'A seeds constraint was violated'],
    [2001, 'ConstraintHasOne', 'A has one constraint was violated'],
    [3012, 'AccountNotInitialized', 'The program expected this account to be already initialized'],
  ])('Anchor %i decodes as %s with program unknown', (code, name, message) => {
    expect(decodeTxError({ InstructionError: [0, { Custom: code }] })).toEqual({
      program: 'unknown', code, name, message,
    })
  })

  it('a code >= 6000 decodes as an unknown CustomProgramError', () => {
    expect(decodeTxError({ InstructionError: [1, { Custom: 6017 }] })).toEqual({
      program: 'unknown', code: 6017, name: 'CustomProgramError', message: 'Custom program error 6017 (0x1781)',
    })
  })

  it('a LiteSVM string without program lines decodes its code', () => {
    const decoded = decodeTxError('TransactionErrorInstructionError { index: 0, error: InstructionErrorCustom { code: 2006 } } :: ')
    expect(decoded).toMatchObject({ program: 'unknown', code: 2006, name: 'ConstraintSeeds' })
  })

  it('a SendTransactionError without logs falls back to the code in its message', () => {
    expect(decodeTxError(simulationError(undefined, 6001))).toMatchObject({
      program: 'unknown', code: 6001, name: 'CustomProgramError',
    })
  })
})

describe('decodeTxError: wallet rejection', () => {
  it('a wallet-adapter rejection decodes as wallet', () => {
    const rejected = new FakeWalletError('WalletSignTransactionError', 'User rejected the request.')
    expect(decodeTxError(rejected)).toEqual({
      program: 'wallet', code: null, name: 'UserRejected', message: 'User rejected the request.',
    })
  })

  it('matches on the error name when the message is empty', () => {
    const rejected = new FakeWalletError('UserRejectedRequestError', '')
    expect(decodeTxError(rejected)).toEqual({
      program: 'wallet', code: null, name: 'UserRejected', message: 'The transaction was rejected in the wallet',
    })
  })
})

describe('decodeTxError: unrecognised input', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['a plain string', 'hello world'],
    ['an empty object', {}],
    ['an array', [1, 2, 3]],
    ['a generic Error', new Error('boom')],
    ['a non-custom InstructionError', { InstructionError: [0, 'InvalidAccountData'] }],
    ['a malformed InstructionError', { InstructionError: 'x' }],
    ['a negative custom code', { InstructionError: [0, { Custom: -1 }] }],
    ['a fractional custom code', { InstructionError: [0, { Custom: 1.5 }] }],
    ['a code above u32', { InstructionError: [0, { Custom: 2 ** 32 }] }],
    ['logs without a failure', { logs: [`Program ${ROUTER} invoke [1]`, `Program ${ROUTER} success`] }],
    ['logs that are not strings', { logs: [1, 2] }],
  ])('%s returns null', (_label, input) => {
    expect(decodeTxError(input)).toBeNull()
  })
})

describe('decodeTxError: results are immutable', () => {
  it('returns a frozen object', () => {
    expect(Object.isFrozen(decodeTxError({ InstructionError: [0, { Custom: 2006 }] }))).toBe(true)
  })
})
