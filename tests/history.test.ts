import assert from 'node:assert/strict';
import test from 'node:test';
import { dayTrend, dayTrendScale } from '../src/game/marketHistory.ts';
import { liveChartData } from '../src/game/liveChart.ts';
import type { Candle, Market, PricePoint } from '../shared/types.ts';

const now = 1_800_000_000_000;
const end = now / 1000;
const candle = (time: number, close: number): Candle => ({ time, open: close, high: close, low: close, close, volume: 1 });
const point = (time: number, value: number): PricePoint => ({ time, value });
const market = (coin: Market['coin'], prices: number[] = []): Market => ({
  coin,
  mark: prices.at(-1) ?? 100,
  change24h: prices.length ? prices.at(-1)! - 100 : 0,
  bid: 99,
  ask: 101,
  time: now,
  candles: [],
  candleSets: {},
  priceHistory: [],
  volume24h: 1,
  bids: [],
  asks: [],
  available: true,
});

test('daily trends use each coin native day history, never the short 1m array or another coin', () => {
  const btc = market('BTC', [100, 101, 102]), eth = market('ETH', [100, 97, 95]);
  btc.candleSets = { '15m': [100, 101, 102].map((value, index) => candle(end - (2 - index) * 900, value)) };
  eth.candleSets = { '15m': [100, 97, 95].map((value, index) => candle(end - (2 - index) * 900, value)) };
  assert.deepEqual(dayTrend(btc, now).points.map(point => Math.round(point.percent)), [0, 1, 2]);
  assert.deepEqual(dayTrend(eth, now).points.map(point => Math.round(point.percent)), [0, -3, -5]);
  assert.equal(dayTrend({ ...btc, candleSets: {} }, now).points.length, 0);
  assert.equal(dayTrend(btc, now).coin, 'BTC');
  assert.equal(dayTrend(eth, now).coin, 'ETH');
});

test('shared daily scale preserves different movement magnitudes and includes both directions', () => {
  const btc = market('BTC', [100, 102]), eth = market('ETH', [100, 95]);
  btc.candleSets = { '15m': [100, 102].map((value, index) => candle(end - (1 - index) * 900, value)) };
  eth.candleSets = { '15m': [100, 95].map((value, index) => candle(end - (1 - index) * 900, value)) };
  const trends = [dayTrend(btc, now), dayTrend(eth, now)];
  const scale = dayTrendScale(trends);
  assert.ok(scale >= 5 && scale <= 6);
  assert.ok(Math.abs(trends[1].points[1].percent / scale) > Math.abs(trends[0].points[1].percent / scale) * 2);
  assert.equal(dayTrendScale([]), 1);
});

test('daily history excludes old, future and invalid prices without inventing samples', () => {
  const source = market('SOL', [100, 101]);
  source.candleSets = { '15m': [candle(end - 86_401, 999), candle(end - 1000, NaN), candle(end - 900, 101), candle(end + 1, 999)] };
  assert.equal(dayTrend(source, now).points.length, 1);
  assert.equal(dayTrend({ ...source, change24h: -100 }, now).points.length, 0);
});

test('1m, 5m and 15m windows are real elapsed-time windows', () => {
  const source = market('BTC');
  source.priceHistory = [point(end - 901, 99), point(end - 899, 100), point(end - 299, 101), point(end - 1, 102)];
  assert.deepEqual(liveChartData(source, 1, now).data.map(item => item.time), [end - 1]);
  assert.equal(liveChartData(source, 5, now).windowSeconds, 300);
  assert.deepEqual(liveChartData(source, 5, now).data.map(item => item.time), [end - 299, end - 1]);
  assert.equal(liveChartData(source, 15, now).windowSeconds, 900);
  assert.deepEqual(liveChartData(source, 15, now).data.map(item => item.time), [end - 899, end - 299, end - 1]);
});

test('only completed native candles backfill the period before live marks', () => {
  const source = market('ETH');
  source.candles = [candle(end - 60, 200), candle(end - 30, 201)];
  const result = liveChartData(source, 1, now);
  assert.deepEqual(result.data, [point(end, 200)]);
  assert.equal(result.historicSamples, 1);
  assert.equal(result.liveSamples, 0);
});

test('the 15m view backfills with actual 1m closes instead of one sparse 15m bar', () => {
  const source = market('AVAX');
  source.candles = [candle(end - 900, 8), candle(end - 840, 8.1), candle(end - 780, 8.2)];
  source.candleSets = { '15m': [candle(end - 900, 999)] };
  const result = liveChartData(source, 15, now);
  assert.deepEqual(result.data, [point(end - 840, 8), point(end - 780, 8.1), point(end - 720, 8.2)]);
  assert.equal(result.data.some(sample => sample.value === 999), false);
});

test('real marks take precedence and historical closes do not leak past live coverage', () => {
  const source = market('SOL');
  source.candles = [candle(end - 115, 10), candle(end - 90, 11), candle(end - 80, 12)];
  source.priceHistory = [point(end - 40, 20), point(end - 10, 21)];
  const result = liveChartData(source, 1, now);
  assert.deepEqual(result.data, [point(end - 55, 10), point(end - 40, 20), point(end - 10, 21)]);
  assert.equal(result.historicSamples, 1);
  assert.equal(result.liveSamples, 2);
  assert.ok(result.data.every(item => item.value !== 12));
});

test('invalid, future and old points are omitted; an empty chart does not invent a line', () => {
  const source = market('XRP');
  source.priceHistory = [point(end - 61, 3), point(end + 1, 4), point(end - 4, 0), point(NaN, 5)];
  source.time = 0;
  assert.deepEqual(liveChartData(source, 1, now).data, []);
  source.time = now - 61_000;
  assert.deepEqual(liveChartData(source, 1, now).data, []);
  source.priceHistory = [];
  source.time = now - 1_000;
  assert.deepEqual(liveChartData(source, 1, now).data, [point(end - 1, source.mark)]);
});
