import type { Candle, Market, PricePoint } from '../../shared/types';

export interface LiveChartData {
  data: PricePoint[];
  historicSamples: number;
  liveSamples: number;
  windowSeconds: number;
  start: number;
  end: number;
}

const validPoint = (point: PricePoint, now: number): boolean =>
  Number.isFinite(point.time) && point.time > 0 && point.time <= now && Number.isFinite(point.value) && point.value > 0;

/** Build a close-up line from actual exchange marks and completed native candles.
 * Candle closes only fill the time before live marks begin. Timestamps and
 * observed prices are never moved, interpolated, or duplicated. */
export function liveChartData(market: Market, minutes = 1, nowMs = Date.now()): LiveChartData {
  const windowSeconds = Math.max(1, minutes * 60);
  const end = nowMs / 1000;
  const start = end - windowSeconds;
  const live = (market.priceHistory ?? [])
    .filter(point => validPoint(point, end) && point.time >= start)
    .sort((a, b) => a.time - b.time);
  const firstLiveTime = live[0]?.time ?? Infinity;

  const historical = market.candles
    .map(candle => ({ time: candle.time + 60, value: candle.close }))
    .filter(point => validPoint(point, end) && point.time >= start && point.time < firstLiveTime)
    .sort((a, b) => a.time - b.time);

  // On a fresh server start, the mark may arrive just before the history
  // endpoint's first response. Use the timestamped quote once, never Date.now().
  if (!live.length && !historical.length && market.time > 0) {
    const quote = { time: market.time / 1000, value: market.mark };
    if (validPoint(quote, end) && quote.time >= start) live.push(quote);
  }

  const byTime = new Map<number, PricePoint>();
  for (const point of historical) byTime.set(point.time, point);
  for (const point of live) byTime.set(point.time, point);
  const data = [...byTime.values()].sort((a, b) => a.time - b.time);
  return { data, historicSamples: historical.length, liveSamples: live.length, windowSeconds, start, end };
}
