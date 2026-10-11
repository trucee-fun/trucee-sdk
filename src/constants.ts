/**
 * Program ids and on-chain constants mirrored from zpvp/programs (router math.rs and account layouts),
 * plus the per-cluster addressing config (program ids and allowed quote mints).
 */
import { PublicKey } from '@solana/web3.js'
import type { Cluster, ClusterConfig, QuoteMintInfo } from './types.js'

export const ROUTER_PROGRAM_ID = new PublicKey('D4sk6wwELD6cmd7tv6hE4hkxQP8SF8tjdegYym8iWNNb')
export const HOOK_PROGRAM_ID = new PublicKey('CUNNV1MqVB53N4jWn91uVFXm1dBSyaynR6iBCbufJWMS')
export const DBC_PROGRAM_ID = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN')

/** DBC fee numerators are parts per FEE_DENOMINATOR. */
export const FEE_DENOMINATOR = 1_000_000_000n
/** Basis withheld per buy to absorb DBC's pool-favoured rounding. */
export const DUST_PER_BUY = 16n
/** Withheld per exit so many tiny exits cannot drain the buffer through rounding dust. */
export const HAIRCUT_PER_EXIT = 2n

/** Market: discriminator 8 | 7 pubkeys | fee u64 | bump u8 | total_basis u64 | finalized u8 | 3 x u64. */
export const MARKET_ACCOUNT_SIZE = 274
/**
 * Router v6 Market (ONC-15): the v5 layout plus basis_bought_total u64 | retention u8 | fees_settled u8 |
 * fees_claimed u64 | creator_paid u64, appended at offsets 274/282/283/284/292.
 */
export const MARKET_ACCOUNT_SIZE_V6 = 300
/** Position without auto-exit: discriminator 8 | owner | market | tokens u64 | basis u64 | bump u8. */
export const POSITION_ACCOUNT_SIZE_V1 = 89
/** Position with the trailing auto_exit_deadline i64. */
export const POSITION_ACCOUNT_SIZE_V2 = 97

const SPL_TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')

/* Quote mints and caps mirror QUOTE_CAPS in zpvp/programs/zpvp_router/src/lib.rs. */

const SOL_QUOTE: QuoteMintInfo = Object.freeze({
  symbol: 'SOL',
  mint: new PublicKey('So11111111111111111111111111111111111111112'),
  decimals: 9,
  tokenProgram: SPL_TOKEN_PROGRAM_ID,
  maxMigrationQuoteThreshold: 10_000_000_000n, // 10 SOL
  tokenBadge: null,
})

const TSLAX_QUOTE: QuoteMintInfo = Object.freeze({
  symbol: 'TSLAx',
  mint: new PublicKey('XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB'),
  decimals: 8,
  tokenProgram: TOKEN_2022_PROGRAM_ID,
  maxMigrationQuoteThreshold: 500_000_000n, // 5 shares
  tokenBadge: new PublicKey('XhM8atXDua58KZnZFLu5vJjzaNWjXaEvpPPEVnHn1ax'),
})

const NVDAX_QUOTE: QuoteMintInfo = Object.freeze({
  symbol: 'NVDAx',
  mint: new PublicKey('Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh'),
  decimals: 8,
  tokenProgram: TOKEN_2022_PROGRAM_ID,
  maxMigrationQuoteThreshold: 1_000_000_000n, // 10 shares
  tokenBadge: new PublicKey('mfacWnGh1Kn5ttHMMaNZhRZbCjvGrDQyDyZgqaR9vBM'),
})

/** Devnet is SOL-only; xStocks exist on mainnet (and in LiteSVM via mainnet fixtures). */
const DEVNET_QUOTES: readonly QuoteMintInfo[] = Object.freeze([SOL_QUOTE])
const MAINNET_QUOTES: readonly QuoteMintInfo[] = Object.freeze([SOL_QUOTE, TSLAX_QUOTE, NVDAX_QUOTE])

const clusterConfig = (cluster: Cluster, quoteMints: readonly QuoteMintInfo[]): ClusterConfig =>
  Object.freeze({
    cluster,
    routerProgramId: ROUTER_PROGRAM_ID,
    hookProgramId: HOOK_PROGRAM_ID,
    dbcProgramId: DBC_PROGRAM_ID,
    quoteMints,
  })

const CLUSTER_CONFIGS: Readonly<Record<Cluster, ClusterConfig>> = Object.freeze({
  devnet: clusterConfig('devnet', DEVNET_QUOTES),
  'mainnet-beta': clusterConfig('mainnet-beta', MAINNET_QUOTES),
  localnet: clusterConfig('localnet', MAINNET_QUOTES),
})

const isCluster = (value: unknown): value is Cluster =>
  typeof value === 'string' && Object.hasOwn(CLUSTER_CONFIGS, value)

/** Frozen addressing config (program ids and allowed quote mints) of a cluster; throws on an unknown cluster. */
export function getClusterConfig(cluster: Cluster): ClusterConfig {
  if (!isCluster(cluster)) {
    const expected = Object.keys(CLUSTER_CONFIGS).join(', ')
    throw new Error(`Unknown cluster ${JSON.stringify(String(cluster))}: expected one of ${expected}`)
  }
  return CLUSTER_CONFIGS[cluster]
}
