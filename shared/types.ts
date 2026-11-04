export const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'AVAX'] as const;
export type Coin = typeof COINS[number];
export const MARGINS = [100, 250, 500] as const;
export const ROUND_DURATIONS = [60, 120, 180, 240, 300] as const;
export const DEFAULT_ROUND_SECONDS = 300;
export function isRoundDuration(value: unknown): value is typeof ROUND_DURATIONS[number] {
  return ROUND_DURATIONS.some(duration => duration === value);
}
export type TradeAction = 'long' | 'short' | 'half' | 'close';
export type InputAction = TradeAction | 'previous' | 'next' | 'up' | 'down' | 'marginDown' | 'marginUp' | 'ready' | 'select';
export const CHART_INTERVALS = ['1m', '5m', '15m'] as const;
export type ChartInterval = typeof CHART_INTERVALS[number];
export interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }
/** Actual received reference-price observation; time is Unix seconds. */
export interface PricePoint { time: number; value: number }
export interface Level { price: number; size: number }
export interface Quote { coin: Coin; mark: number; bid: number; ask: number; time: number; providerTime?: number }
export interface FeedClockInfo { calibrated: boolean; offsetMs: number; measuredSkewMs: number; normalized: boolean; source: 'hyperliquid-https-date'; error?: string }
export interface Market extends Quote { candles: Candle[]; candleSets?: Partial<Record<ChartInterval, Candle[]>>; priceHistory?: PricePoint[]; bids: Level[]; asks: Level[]; change24h: number; volume24h: number; available: boolean }
export interface Position { coin: Coin; quantity: number; entry: number; margin: number; unrealizedPnl: number }
export interface Account { cash: number; equity: number; realizedPnl: number; unrealizedPnl: number; fees: number; reservedMargin: number; availableMargin: number; peakEquity: number; maxDrawdown: number; score: number; disabled: boolean; positions: Position[]; nonce: number }
export interface LedgerSnapshot { accounts: [Account, Account]; winner: number | null; txHash?: string }
export interface LedgerInfo { mode: 'local-evm' | 'monad'; chainId: number; contractAddress: string; relayerAddress: string; explorer?: string }
export interface Player extends Account { name: string; connected: boolean; ready: boolean; selected: number; margin: number; disconnectedAt?: number }
export interface Fill { id: string; time: number; seat: number; coin: Coin; action: TradeAction; quantity: number; price: number; fee: number; txHash: string }
export type Phase = 'lobby' | 'registering' | 'countdown' | 'active' | 'settling' | 'finished' | 'void';
export type StakeAsset = 'MON' | 'SOL' | 'ETH';
export interface Stake { asset: StakeAsset; amount: number }
export interface DemoSession { accountId: string; mode: 'demo'; balances: Record<StakeAsset, number>; reserved: Record<StakeAsset, number>; walletAddress?: string }
export interface EscrowFunding { mode: 'monad-testnet'; roomId: string; escrowRoomId: string; contractAddress: string; chainId: 10143; hostFunded: boolean; guestFunded: boolean; status: 'awaiting-host' | 'open' | 'funded' | 'claimable' | 'refunded'; refundAfter: number; hostAddress: string; guestAddress?: string }
export interface RoomSummary { id: string; code: string; host: string; mode: 'local' | 'online'; phase: Phase; players: number; stake: Stake | null; createdAt: number; funding?: EscrowFunding; roundSeconds?: number }
export interface MatchState { id: string; code: string; mode: 'local' | 'online'; phase: Phase; players: [Player, Player]; startAt: number; endAt: number; serverTime: number; ledger: LedgerInfo; winner: number | null; reason?: string; fills: Fill[]; txHash?: string; stake?: Stake; stakeStatus?: 'reserved' | 'paid' | 'refunded'; funding?: EscrowFunding; roundSeconds?: number }
export type ClientMessage = { type: 'create'; mode: 'local' | 'online'; name: string; name2?: string; stake?: Stake; visibility?: 'public' | 'private'; fundingMode?: 'demo' | 'monad-testnet'; roundSeconds?: number } | { type: 'join'; code: string; name: string } | { type: 'resume'; code: string; token: string } | { type: 'action'; id: string; seat: number; action: InputAction; market?: number } | { type: 'rematch' } | { type: 'leave' } | { type: 'ping'; time: number };
export type ServerMessage = { type: 'welcome'; code: string; token: string; seats: number[] } | { type: 'left' } | { type: 'state'; state: MatchState } | { type: 'markets'; markets: Market[]; serverTime: number; source: 'hyperliquid' | 'test-fixture'; connected: boolean; clock?: FeedClockInfo } | { type: 'feedback'; seat: number; kind: 'fill' | 'reject' | 'select' | 'ready' | 'risk'; message: string; id?: string } | { type: 'error'; message: string } | { type: 'pong'; time: number; serverTime: number };
