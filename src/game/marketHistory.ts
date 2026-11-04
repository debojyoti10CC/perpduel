import type { Coin, Market } from '../../shared/types';

export interface DayTrend { coin: Coin; start: number; end: number; points: { time: number; percent: number }[] }

/** Use this coin's native 15m dataset over the last day. Never substitute a
 * different coin or the short 1m history while the daily dataset is loading. */
export function dayTrend(market: Market, now: number): DayTrend {
  const end = now / 1000, start = end - 86_400;
  // change24h and mark come from the same asset context; reversing the return
  // recovers Hyperliquid's actual prevDayPx as the common 0% reference.
  const reference = market.mark / (1 + market.change24h / 100);
  if (!Number.isFinite(reference) || reference <= 0) return { coin: market.coin, start, end, points: [] };
  const points = (market.candleSets?.['15m'] ?? [])
    .filter(candle => candle.time >= start && candle.time <= end && Number.isFinite(candle.close) && candle.close > 0)
    .map(candle => ({ time: candle.time, percent: (candle.close / reference - 1) * 100 }));
  return { coin: market.coin, start, end, points };
}

/** All rows share one symmetric percentage scale, preserving differences in
 * movement size instead of stretching every coin to fill its own mini-chart. */
export function dayTrendScale(trends: DayTrend[]): number {
  return Math.max(1, Math.ceil(Math.max(0, ...trends.flatMap(trend => trend.points.map(point => Math.abs(point.percent))))));
}
