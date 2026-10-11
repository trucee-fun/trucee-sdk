/**
 * Zero-PvP launch: the DBC config preset and the transactions that create config, pool and router market.
 */
import type { ConfigParameters } from '@meteora-ag/dynamic-bonding-curve-sdk'
import type { LaunchParams, LaunchPlan, PresetOptions } from './types.js'

/** DBC ConfigParameters for a transfer-hook pool the router accepts. */
export function buildZeroPvpConfigParameters(opts: PresetOptions): ConfigParameters {
  throw new Error('not implemented: buildZeroPvpConfigParameters')
}

export async function buildLaunchPlan(p: LaunchParams): Promise<LaunchPlan> {
  throw new Error('not implemented: buildLaunchPlan')
}
