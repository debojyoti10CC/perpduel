import WebSocket from 'ws';
import { COINS, CHART_INTERVALS, type ChartInterval, type Candle, type Coin, type FeedClockInfo, type Level, type Market, type PricePoint, type Quote } from '../shared/types.ts';

const HTTP_URL = 'https://api.hyperliquid.xyz/info';
const WS_URL = 'wss://api.hyperliquid.xyz/ws';
const MAX_AGE_MS = 5_000;
const PRICE_HISTORY_SECONDS = 15 * 60;
const INTERVAL_MS: Record<ChartInterval, number> = { '1m': 60_000, '5m': 300_000, '15m': 900_000 };
const isChartInterval = (value: unknown): value is ChartInterval => typeof value === 'string' && CHART_INTERVALS.includes(value as ChartInterval);
type Observation = { observedAt: number; quote: Quote };
const latestBefore = (history: Observation[], asOf: number): Observation | undefined => { for (let index = history.length - 1; index >= 0; index--) if (history[index].observedAt <= asOf) return history[index]; return undefined; };

/** Chart-only observations: no resampling, interpolation or ledger timestamp changes.
 * Keep the newest actual receipt in each second and never move a point forward
 * to disguise a backward clock correction. */
function recordPrice(history: PricePoint[], value: number, observedAt: number): void {
  const time = observedAt / 1000;
  if (!Number.isFinite(time) || time <= 0 || !Number.isFinite(value) || value <= 0) return;
  const last = history.at(-1);
  if (last && time < last.time) return;
  const point = { time, value };
  if (last && Math.floor(last.time) === Math.floor(time)) history[history.length - 1] = point;
  else history.push(point);
  const cutoff = time - PRICE_HISTORY_SECONDS;
  while (history.length && history[0].time < cutoff) history.shift();
}
const priceSnapshot = (history: PricePoint[], now: number): PricePoint[] => history
  .filter(point => point.time >= now / 1000 - PRICE_HISTORY_SECONDS && point.time <= now / 1000)
  .map(point => ({ ...point }));
export interface MarketFeed {
  readonly source: 'hyperliquid' | 'test-fixture';
  readonly connected: boolean;
  readonly lastError: string | null;
  readonly clock?: FeedClockInfo;
  readonly diagnostics?: { recoveries: number; lastRecoveryAt: number; markets: { coin: Coin; bookAgeMs: number; markAgeMs: number }[] };
  start(): Promise<void>;
  stop(): void;
  snapshot(now?: number): Market[];
  quotes(asOf?: number): Quote[] | null;
}

/** The Date header has one-second precision. This lower bound deliberately
 * overstates quote age by the response's clock uncertainty and network time.
 * It never replaces an old timestamp with a receipt timestamp. */
export function clockCalibration(requestStartedAt: number, responseReceivedAt: number, dateHeader: string | null): { offsetMs: number; measuredSkewMs: number } | null {
  const providerDate = dateHeader ? Date.parse(dateHeader) : NaN;
  if (!Number.isFinite(providerDate) || !Number.isFinite(requestStartedAt) || !Number.isFinite(responseReceivedAt) || responseReceivedAt < requestStartedAt || responseReceivedAt - requestStartedAt > 10_000) return null;
  const measuredSkewMs = (requestStartedAt + responseReceivedAt) / 2 - (providerDate + 500);
  const offsetMs = Math.floor(requestStartedAt - (providerDate + 1000));
  return Math.abs(measuredSkewMs) <= 60_000 && Math.abs(offsetMs) <= 60_000 ? { offsetMs, measuredSkewMs } : null;
}

const emptyMarket = (coin: Coin): Market => {
  const candleSets: Record<ChartInterval, Candle[]> = { '1m': [], '5m': [], '15m': [] };
  return { coin, mark: 0, bid: 0, ask: 0, time: 0, candles: candleSets['1m'], candleSets, bids: [], asks: [], change24h: 0, volume24h: 0, available: false };
};
const positive = (value: unknown): number => { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : 0; };
const levels = (value: unknown): Level[] => Array.isArray(value) ? value.map((x: any) => ({ price: positive(x.px), size: positive(x.sz) })).filter(x => x.price && x.size).slice(0, 15) : [];
function parseCandle(x: any): Candle | null {
  const candle: Candle = { time: Math.floor(Number(x.t) / 1000), open: positive(x.o), high: positive(x.h), low: positive(x.l), close: positive(x.c), volume: Number(x.v) };
  return Number.isFinite(candle.time) && candle.open > 0 && candle.high >= Math.max(candle.open, candle.close) && candle.low <= Math.min(candle.open, candle.close) && candle.low > 0 && candle.close > 0 && Number.isFinite(candle.volume) && candle.volume >= 0 ? candle : null;
}

/** Live exchange data only. A failed provider never becomes a synthetic price. */
export class HyperliquidFeed implements MarketFeed {
  readonly source = 'hyperliquid' as const;
  connected = false;
  lastError: string | null = null;
  private markets = new Map<Coin, Market>(COINS.map(coin => [coin, emptyMarket(coin)]));
  private observations = new Map<Coin, Observation[]>(COINS.map(coin => [coin, []]));
  private priceHistory = new Map<Coin, PricePoint[]>(COINS.map(coin => [coin, []]));
  private markTimes = new Map<Coin, number>();
  private bookTimes = new Map<Coin, number>();
  private allowed = new Set<Coin>();
  private socket?: WebSocket;
  private reconnect?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private refresh?: ReturnType<typeof setInterval>;
  private watchdog?: ReturnType<typeof setInterval>;
  private stopped = false;
  private attempts = 0;
  private lastMessage = 0;
  private bookReceivedAt = new Map<Coin, number>();
  private normalizedBookTimes = new Map<Coin, number>();
  private lastPublishedTimes = new Map<Coin, number>();
  private recovering = false;
  private recoveryCount = 0;
  private lastRecoveryAt = 0;
  private loadingCandles = false;
  private clockInfo: FeedClockInfo = { calibrated: false, offsetMs: 0, measuredSkewMs: 0, normalized: false, source: 'hyperliquid-https-date' };
  constructor(private readonly normalizeProviderTime = true) {}
  get clock(): FeedClockInfo { return { ...this.clockInfo }; }
  get diagnostics() { const now = Date.now(); return { recoveries: this.recoveryCount, lastRecoveryAt: this.lastRecoveryAt, markets: COINS.map(coin => ({ coin, bookAgeMs: now - (this.bookReceivedAt.get(coin) ?? 0), markAgeMs: now - (this.markTimes.get(coin) ?? 0) })) }; }

  async start(): Promise<void> {
    this.stopped = false;
    // Start the stream immediately; metadata gates execution until verified.
    this.connect();
    await this.loadMetadata().catch(error => { this.lastError = `Hyperliquid metadata: ${error.message}`; });
    void this.loadCandles();
    // Recheck the HTTPS clock periodically: OS clock correction must not leave
    // a previously valid provider-to-host offset permanently in the future.
    this.refresh = setInterval(() => { void this.loadMetadata().catch(error => { this.lastError = `Hyperliquid metadata: ${error.message}`; }); }, 15_000);
    this.watchdog = setInterval(() => {
      const now = Date.now();
      const stalled = COINS.some(coin => { const time = this.markets.get(coin)!.time; return now - (this.bookReceivedAt.get(coin) ?? 0) > 8_000 || now - (this.markTimes.get(coin) ?? 0) > 8_000 || now - time > 8_000 || time > now + 2_000; });
      if (stalled && !this.recovering && now - this.lastRecoveryAt >= 8_000) void this.recover();
    }, 2_000);
  }
  private async info(body: unknown): Promise<any> {
    const started = Date.now();
    const response = await fetch(HTTP_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const calibrated = clockCalibration(started, Date.now(), response.headers.get('date'));
    if (!calibrated) { this.clockInfo.error = 'Unable to verify the provider clock within a bounded 60-second offset'; }
    else {
      this.clockInfo = { calibrated: true, offsetMs: this.normalizeProviderTime ? calibrated.offsetMs : 0, measuredSkewMs: calibrated.measuredSkewMs, normalized: this.normalizeProviderTime, source: 'hyperliquid-https-date' };
      if (!this.normalizeProviderTime && Math.abs(calibrated.measuredSkewMs) > 2_000) this.clockInfo.error = 'Server clock differs from provider UTC by over two seconds. Synchronize the server clock before Monad play.';
    }
    return response.json();
  }
  private async loadMetadata(): Promise<void> {
    const response = await this.info({ type: 'metaAndAssetCtxs' });
    if (!Array.isArray(response) || !Array.isArray(response[0]?.universe)) throw new Error('Malformed asset metadata');
    const nextAllowed = new Set<Coin>();
    response[0].universe.forEach((asset: any, index: number) => {
      if (!COINS.includes(asset.name) || asset.isDelisted) return;
      const coin = asset.name as Coin;
      nextAllowed.add(coin);
      this.applyContext(coin, response[1]?.[index]);
    });
    this.allowed = nextAllowed;
    this.lastError = COINS.every(x => this.allowed.has(x)) ? null : 'One or more requested perpetuals are unavailable at Hyperliquid';
  }
  private async loadCandles(): Promise<void> {
    if (this.loadingCandles) return;
    this.loadingCandles = true;
    // Native histories keep every selected interval useful: 15m gets 180 real
    // 15-minute candles, rather than only 12 aggregates from a three-hour feed.
    // Load 1m for all markets first, with at most two REST requests in flight.
    const requests = CHART_INTERVALS.flatMap(interval => COINS.map(coin => ({ coin, interval })));
    try {
      for (let i = 0; i < requests.length && !this.stopped; i += 2) {
        await Promise.all(requests.slice(i, i + 2).map(async ({ coin, interval }) => {
          try {
            const endTime = Date.now();
            const data = await this.info({ type: 'candleSnapshot', req: { coin, interval, startTime: endTime - 180 * INTERVAL_MS[interval], endTime } });
            if (!Array.isArray(data)) throw new Error('Malformed candle snapshot');
            const byTime = new Map<number, Candle>();
            for (const raw of data) {
              if (raw?.s !== coin || raw?.i !== interval) continue;
              const candle = parseCandle(raw);
              if (candle) byTime.set(candle.time, candle);
            }
            const market = this.markets.get(coin)!;
            // Stream observations received while REST was in flight are newer.
            for (const candle of market.candleSets?.[interval] ?? []) byTime.set(candle.time, candle);
            const candles = [...byTime.values()].sort((a, b) => a.time - b.time).slice(-180);
            market.candleSets![interval] = candles;
            if (interval === '1m') market.candles = candles;
          } catch (error: any) { this.lastError = `${coin} ${interval} candle history: ${error.message}`; }
        }));
      }
    } finally { this.loadingCandles = false; }
  }
  private applyCandle(coin: Coin, interval: ChartInterval, candle: Candle): void {
    const market = this.markets.get(coin)!;
    const byTime = new Map((market.candleSets?.[interval] ?? []).map(item => [item.time, item]));
    byTime.set(candle.time, candle);
    const candles = [...byTime.values()].sort((a, b) => a.time - b.time).slice(-180);
    market.candleSets![interval] = candles;
    if (interval === '1m') market.candles = candles;
  }
  private connect(): void {
    if (this.stopped) return;
    const socket = this.socket = new WebSocket(WS_URL, { handshakeTimeout: 10_000 });
    socket.on('open', () => {
      if (socket !== this.socket || this.stopped) { socket.terminate(); return; }
      this.connected = true;
      this.lastMessage = Date.now();
      this.attempts = 0;
      for (const coin of COINS) {
        for (const subscription of [{ type: 'activeAssetCtx', coin }, { type: 'l2Book', coin, fast: true }, ...CHART_INTERVALS.map(interval => ({ type: 'candle', coin, interval }))]) socket.send(JSON.stringify({ method: 'subscribe', subscription }));
      }
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => {
        if (Date.now() - this.lastMessage > 35_000) return socket.terminate();
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ method: 'ping' }));
      }, 15_000);
    });
    socket.on('message', raw => {
      if (socket !== this.socket || this.stopped) return;
      this.lastMessage = Date.now();
      try { this.consume(JSON.parse(raw.toString())); }
      catch { this.lastError = 'Malformed Hyperliquid stream message'; }
    });
    socket.on('error', error => { this.lastError = `Hyperliquid stream: ${error.message}`; });
    socket.on('close', () => {
      if (socket !== this.socket) return;
      this.connected = false;
      if (this.heartbeat) clearInterval(this.heartbeat);
      if (!this.stopped) this.reconnect = setTimeout(() => { this.connect(); void this.loadCandles(); }, Math.min(10_000, 1_000 * 2 ** this.attempts++));
    });
  }
  private async recover(): Promise<void> {
    if (this.stopped || this.recovering) return;
    this.recovering = true; this.lastRecoveryAt = Date.now(); this.recoveryCount++;
    this.lastError = 'Market stream stalled. Reconnecting and requesting real exchange snapshots.';
    // A pong confirms transport liveness, not the health of individual feeds.
    this.socket?.terminate();
    try {
      await this.loadMetadata();
      await Promise.all(COINS.map(async coin => {
        const book = await this.info({ type: 'l2Book', coin });
        if (!this.stopped) this.consume({ channel: 'l2Book', data: book });
      }));
      this.lastError = this.snapshot().every(market => market.available) ? null : 'Waiting for fresh market snapshots after reconnecting.';
    } catch (error: any) { this.lastError = `Market recovery: ${error.message}`; }
    finally { this.recovering = false; }
  }
  private applyContext(coin: Coin, ctx: any): void {
    const market = this.markets.get(coin)!;
    const mark = positive(ctx?.markPx);
    if (!mark) return;
    market.mark = mark;
    market.change24h = positive(ctx.prevDayPx) ? (mark / Number(ctx.prevDayPx) - 1) * 100 : 0;
    market.volume24h = positive(ctx.dayNtlVlm);
    const observedAt = Date.now();
    this.markTimes.set(coin, observedAt);
    recordPrice(this.priceHistory.get(coin)!, mark, observedAt);
    this.record(coin);
  }
  private consume(message: any): void {
    const data = message.data;
    if (message.channel === 'activeAssetCtx' && COINS.includes(data?.coin)) this.applyContext(data.coin, data.ctx);
    if (message.channel === 'l2Book' && COINS.includes(data?.coin)) {
      const market = this.markets.get(data.coin as Coin)!;
      const time = Number(data.time);
      if (!Number.isFinite(time) || time + this.clockInfo.offsetMs > Date.now() + 2_000 || time < (this.bookTimes.get(data.coin) ?? 0)) return;
      market.bids = levels(data.levels?.[0]);
      market.asks = levels(data.levels?.[1]);
      market.bid = market.bids[0]?.price ?? 0;
      market.ask = market.asks[0]?.price ?? 0;
      this.bookTimes.set(data.coin, time);
      // Only a newly received book is normalized. Recalibrating the clock must
      // never re-date a previously received (possibly stale) market snapshot.
      this.normalizedBookTimes.set(data.coin, time + this.clockInfo.offsetMs);
      this.bookReceivedAt.set(data.coin, Date.now());
      this.record(data.coin);
    }
    if (message.channel === 'candle') {
      for (const raw of Array.isArray(data) ? data : [data]) {
        if (!COINS.includes(raw?.s) || !isChartInterval(raw?.i)) continue;
        const candle = parseCandle(raw);
        if (!candle) continue;
        this.applyCandle(raw.s as Coin, raw.i, candle);
      }
    }
  }
  private record(coin: Coin): void {
    const market = this.markets.get(coin)!;
    market.providerTime = this.bookTimes.get(coin) ?? 0;
    market.time = Math.min(this.markTimes.get(coin) ?? 0, this.normalizedBookTimes.get(coin) ?? 0);
    if (!(market.mark > 0 && market.bid > 0 && market.ask >= market.bid && market.time > 0)) return;
    const history = this.observations.get(coin)!;
    // A conservative correction can move the next source timestamp backward.
    // Hold it until the source overtakes the last emitted quote; do not clamp
    // it forward, which would misrepresent its actual age on the ledger.
    if (market.time < (this.lastPublishedTimes.get(coin) ?? 0)) return;
    this.lastPublishedTimes.set(coin, market.time);
    history.push({ observedAt: Date.now(), quote: { coin, mark: market.mark, bid: market.bid, ask: market.ask, time: market.time, providerTime: market.providerTime } });
    while (history.length > 1 && history[0].observedAt < Date.now() - 60_000) history.shift();
  }
  snapshot(now = Date.now()): Market[] {
    return COINS.map(coin => {
      const market = this.markets.get(coin)!;
      return { ...market, candleSets: { ...market.candleSets }, priceHistory: priceSnapshot(this.priceHistory.get(coin)!, now), available: this.clockInfo.calibrated && !this.clockInfo.error && this.allowed.has(coin) && market.time >= (this.lastPublishedTimes.get(coin) ?? 0) && market.time > 0 && now - market.time <= MAX_AGE_MS && market.time <= now && market.mark > 0 && market.bid > 0 && market.ask >= market.bid };
    });
  }
  quotes(asOf = Date.now()): Quote[] | null {
    if (!this.clockInfo.calibrated || this.clockInfo.error) return null;
    const quotes: Quote[] = [];
    for (const coin of COINS) {
      if (!this.allowed.has(coin)) return null;
      const observation = latestBefore(this.observations.get(coin)!, asOf);
      if (!observation || asOf - observation.quote.time > MAX_AGE_MS || observation.quote.time > asOf) return null;
      quotes.push({ ...observation.quote });
    }
    return quotes;
  }
  stop(): void {
    this.stopped = true;
    this.connected = false;
    if (this.reconnect) clearTimeout(this.reconnect);
    if (this.refresh) clearInterval(this.refresh);
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.socket?.terminate();
  }
}

/** Only constructed for an explicitly enabled test harness. Never a live fallback. */
export class FixtureFeed implements MarketFeed {
  readonly source = 'test-fixture' as const;
  connected = true;
  lastError = 'TEST FIXTURE — prices are synthetic, not live exchange data';
  paused = false;
  private timer?: ReturnType<typeof setInterval>;
  private observations = new Map<Coin, Observation[]>(COINS.map(x => [x, []]));
  private priceHistory = new Map<Coin, PricePoint[]>(COINS.map(coin => [coin, []]));
  private markets: Market[] = COINS.map(emptyMarket);
  async start(): Promise<void> { this.tick(); this.timer = setInterval(() => { if (!this.paused) this.tick(); }, 100); }
  private tick(): void {
    const now = Date.now();
    const bases = [68_000, 2_500, 140, .55, .14, 27];
    this.markets = COINS.map((coin, index) => {
      const base = bases[index];
      const mark = base * (1 + .001 * Math.sin(now / 13_000 + index));
      const bid = mark * .9999, ask = mark * 1.0001;
      const candleSets = Object.fromEntries(CHART_INTERVALS.map(interval => {
        const seconds = INTERVAL_MS[interval] / 1000;
        const candles: Candle[] = Array.from({ length: 120 }, (_, n) => {
          const time = Math.floor(now / INTERVAL_MS[interval]) * seconds - (119 - n) * seconds;
          const open = base * (1 + .003 * Math.sin(time / 700 + index));
          const close = base * (1 + .003 * Math.sin((time + seconds) / 700 + index));
          return { time, open, close, high: Math.max(open, close) * 1.0004, low: Math.min(open, close) * .9996, volume: 5 + n % 8 };
        });
        return [interval, candles];
      })) as Record<ChartInterval, Candle[]>;
      const candles = candleSets['1m'];
      recordPrice(this.priceHistory.get(coin)!, mark, now);
      const market: Market = { coin, mark, bid, ask, time: now, candles, candleSets, priceHistory: priceSnapshot(this.priceHistory.get(coin)!, now), bids: Array.from({ length: 10 }, (_, n) => ({ price: bid * (1 - n * .0001), size: 1 + n })), asks: Array.from({ length: 10 }, (_, n) => ({ price: ask * (1 + n * .0001), size: 1 + n })), change24h: .1 * Math.sin(now / 10_000 + index), volume24h: 1_000_000, available: true };
      const history = this.observations.get(coin)!;
      history.push({ observedAt: now, quote: { coin, mark, bid, ask, time: now } });
      while (history.length > 650) history.shift();
      return market;
    });
  }
  snapshot(now = Date.now()): Market[] { return this.markets.map(x => ({ ...x, priceHistory: priceSnapshot(this.priceHistory.get(x.coin)!, now), available: now - x.time <= MAX_AGE_MS })); }
  quotes(asOf = Date.now()): Quote[] | null {
    const found = COINS.map(coin => latestBefore(this.observations.get(coin)!, asOf));
    return found.every(x => x && asOf - x.quote.time <= MAX_AGE_MS) ? found.map(x => ({ ...x!.quote })) : null;
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.connected = false; }
}
