/**
 * Public types of @trucee/sdk. All token and quote amounts are raw base units as bigint.
 * Account layouts mirror zpvp/programs/zpvp_router/src/lib.rs (Market, Position) and its events.
 */
import type { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js'

export type Cluster = 'devnet' | 'mainnet-beta' | 'localnet'

export type QuoteSymbol = 'SOL' | 'TSLAx' | 'NVDAx'

/** A quote mint a market may be opened for, with its router launch cap. */
export interface QuoteMintInfo {
  readonly symbol: QuoteSymbol
  readonly mint: PublicKey
  readonly decimals: number
  readonly tokenProgram: PublicKey
  /** Router cap on the DBC migration quote threshold for this quote (QUOTE_CAPS). */
  readonly maxMigrationQuoteThreshold: bigint
  /** Meteora DBC token badge account, required for Token-2022 quotes such as xStocks. */
  readonly tokenBadge: PublicKey | null
}

export interface ClusterConfig {
  readonly cluster: Cluster
  readonly routerProgramId: PublicKey
  readonly hookProgramId: PublicKey
  readonly dbcProgramId: PublicKey
  readonly quoteMints: readonly QuoteMintInfo[]
}

/** Decoded router `Market` account (one per DBC pool). */
export interface MarketAccount {
  readonly address: PublicKey
  readonly pool: PublicKey
  readonly config: PublicKey
  readonly baseMint: PublicKey
  readonly quoteMint: PublicKey
  readonly baseVault: PublicKey
  readonly quoteVault: PublicKey
  readonly bufferVault: PublicKey
  readonly feeNumerator: bigint
  readonly bump: number
  /** Sum of all open positions' basis. */
  readonly totalBasis: bigint
  readonly finalized: boolean
  readonly surplusSnapshot: bigint
  readonly basisSnapshot: bigint
  readonly surplusClaimed: bigint
}

/** Decoded router `Position` account (one per market and owner). */
export interface PositionAccount {
  readonly address: PublicKey
  readonly owner: PublicKey
  readonly market: PublicKey
  readonly tokens: bigint
  readonly basis: bigint
  readonly bump: number
  /** Unix seconds after which a crank may auto-exit; null for the old 89-byte layout. */
  readonly autoExitDeadline: bigint | null
}

/** Every account a router instruction needs for one market. */
export interface MarketAccounts {
  readonly market: PublicKey
  readonly pool: PublicKey
  readonly config: PublicKey
  readonly baseMint: PublicKey
  readonly quoteMint: PublicKey
  readonly baseVault: PublicKey
  readonly quoteVault: PublicKey
  readonly bufferVault: PublicKey
  readonly quoteTokenProgram: PublicKey
}

export interface BuyEvent {
  readonly name: 'BuyEvent'
  readonly market: PublicKey
  readonly user: PublicKey
  readonly tokensOut: bigint
  readonly netIntoCurve: bigint
  /** Position basis after the buy. */
  readonly basis: bigint
}

export interface SellEvent {
  readonly name: 'SellEvent'
  readonly market: PublicKey
  readonly user: PublicKey
  readonly tokens: bigint
  readonly basisPart: bigint
  readonly proceeds: bigint
  readonly refund: bigint
}

export interface ClaimEvent {
  readonly name: 'ClaimEvent'
  readonly market: PublicKey
  readonly user: PublicKey
  readonly basis: bigint
  readonly share: bigint
}

export interface FinalizeEvent {
  readonly name: 'FinalizeEvent'
  readonly market: PublicKey
  readonly surplus: bigint
  readonly totalBasis: bigint
}

export type RouterEvent = BuyEvent | SellEvent | ClaimEvent | FinalizeEvent

/** Router buy; wraps SOL first when the quote mint is native. */
export interface BuyParams {
  readonly cluster: ClusterConfig
  readonly accounts: MarketAccounts
  readonly user: PublicKey
  readonly amountIn: bigint
  readonly minOut: bigint
}

/** Router sell (exit at cost before graduation). */
export interface SellParams {
  readonly cluster: ClusterConfig
  readonly accounts: MarketAccounts
  readonly user: PublicKey
  readonly tokens: bigint
  readonly unwrapSol: boolean
}

export interface FinalizeParams {
  readonly cluster: ClusterConfig
  readonly market: PublicKey
  readonly pool: PublicKey
  readonly bufferVault: PublicKey
}

/** Permissionless surplus claim: `cranker` signs, the share goes to `owner`. */
export interface ClaimParams {
  readonly cluster: ClusterConfig
  readonly accounts: MarketAccounts
  readonly cranker: PublicKey
  readonly owner: PublicKey
}

export interface InitMarketParams {
  readonly cluster: ClusterConfig
  readonly payer: PublicKey
  readonly pool: PublicKey
  readonly config: PublicKey
  readonly quoteMint: PublicKey
  readonly quoteTokenProgram: PublicKey
}

/** Inputs of the Zero-PvP DBC config preset. */
export interface PresetOptions {
  readonly quote: QuoteMintInfo
  readonly migrationQuoteThreshold: bigint
  readonly feeBps: number
  readonly feeClaimer: PublicKey
  readonly leftoverReceiver: PublicKey
  readonly totalTokenSupply?: bigint
  readonly percentageSupplyOnMigration?: number
}

export interface LaunchParams {
  readonly connection: Connection
  readonly cluster: ClusterConfig
  readonly creator: PublicKey
  readonly name: string
  readonly symbol: string
  readonly uri: string
  readonly preset: PresetOptions
  readonly initialBuy?: bigint
}

/** Transactions to launch a token; `signers[i]` are the extra signers of `transactions[i]`. */
export interface LaunchPlan {
  readonly transactions: Transaction[]
  readonly signers: Keypair[][]
  readonly config: PublicKey
  readonly pool: PublicKey
  readonly baseMint: PublicKey
  readonly market: PublicKey
}

export interface BuyQuote {
  readonly tokensOut: bigint
  readonly fee: bigint
  readonly netIntoCurve: bigint
  readonly basisAdded: bigint
}

export interface ExitQuote {
  readonly basisPart: bigint
  readonly feeAtCost: bigint
  readonly refund: bigint
}

export interface DecodedTxError {
  readonly program: 'router' | 'hook' | 'dbc' | 'wallet' | 'unknown'
  readonly code: number | null
  readonly name: string
  readonly message: string
}
