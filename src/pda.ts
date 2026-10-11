/**
 * Program-derived addresses of the router (market, buffer, position) and the hook (extra-account-metas).
 * Seeds mirror zpvp_router/src/lib.rs (MARKET_SEED, BUFFER_SEED, POSITION_SEED) and
 * zpvp_hook/src/lib.rs (EXTRA_ACCOUNT_METAS_SEED).
 */
import { Buffer } from 'buffer'
import { PublicKey } from '@solana/web3.js'
import { HOOK_PROGRAM_ID, ROUTER_PROGRAM_ID } from './constants.js'

const MARKET_SEED = 'market'
const BUFFER_SEED = 'buffer'
const POSITION_SEED = 'position'
const EXTRA_ACCOUNT_METAS_SEED = 'extra-account-metas'

const PUBLIC_KEY_LENGTH = 32

/** A caller-supplied key and its parameter name, for error messages. */
type NamedKey = readonly [key: PublicKey, name: string]

/** Duck-typed so keys from another @solana/web3.js copy (common in apps) are still accepted. */
function keyBytes([key, name]: NamedKey): Uint8Array {
  if (typeof (key as { toBytes?: unknown } | null | undefined)?.toBytes !== 'function') {
    throw new TypeError(`${name} must be a PublicKey`)
  }
  const bytes = key.toBytes()
  if (bytes.length !== PUBLIC_KEY_LENGTH) {
    throw new TypeError(`${name} must be a PublicKey of ${PUBLIC_KEY_LENGTH} bytes, got ${bytes.length}`)
  }
  return bytes
}

function findPda(programId: NamedKey, seed: string, ...keys: readonly NamedKey[]): PublicKey {
  const seeds = [Buffer.from(seed, 'utf8'), ...keys.map(keyBytes)]
  const [address] = PublicKey.findProgramAddressSync(seeds, new PublicKey(keyBytes(programId)))
  return address
}

/** ["market", pool] under the router. */
export function findMarketPda(pool: PublicKey, routerProgramId: PublicKey = ROUTER_PROGRAM_ID): PublicKey {
  return findPda([routerProgramId, 'routerProgramId'], MARKET_SEED, [pool, 'pool'])
}

/** ["buffer", market] under the router: the market's quote buffer vault. */
export function findBufferPda(market: PublicKey, routerProgramId: PublicKey = ROUTER_PROGRAM_ID): PublicKey {
  return findPda([routerProgramId, 'routerProgramId'], BUFFER_SEED, [market, 'market'])
}

/** ["position", market, owner] under the router. */
export function findPositionPda(
  market: PublicKey,
  owner: PublicKey,
  routerProgramId: PublicKey = ROUTER_PROGRAM_ID,
): PublicKey {
  return findPda([routerProgramId, 'routerProgramId'], POSITION_SEED, [market, 'market'], [owner, 'owner'])
}

/** ["extra-account-metas", baseMint] under the hook. */
export function findExtraAccountMetasPda(baseMint: PublicKey, hookProgramId: PublicKey = HOOK_PROGRAM_ID): PublicKey {
  return findPda([hookProgramId, 'hookProgramId'], EXTRA_ACCOUNT_METAS_SEED, [baseMint, 'baseMint'])
}
