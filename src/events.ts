/**
 * Router events emitted with Anchor `emit!` ("Program data: <base64>" log lines).
 */
import type { PublicKey } from '@solana/web3.js'
import { ROUTER_PROGRAM_ID } from './constants.js'
import type { RouterEvent } from './types.js'

/** Anchor event discriminators: sha256("event:<Name>")[..8]. */
export const EVENT_DISCRIMINATORS: Readonly<Record<RouterEvent['name'], Buffer>> = Object.freeze({
  BuyEvent: Buffer.from([103, 244, 82, 31, 44, 245, 119, 119]),
  SellEvent: Buffer.from([62, 47, 55, 10, 165, 3, 220, 42]),
  ClaimEvent: Buffer.from([93, 15, 70, 170, 48, 140, 212, 219]),
  FinalizeEvent: Buffer.from([115, 140, 131, 4, 181, 52, 170, 148]),
})

/** Decodes router events from a transaction's log messages, in log order. */
export function parseRouterEvents(
  logs: readonly string[],
  routerProgramId: PublicKey = ROUTER_PROGRAM_ID,
): RouterEvent[] {
  throw new Error('not implemented: parseRouterEvents')
}
