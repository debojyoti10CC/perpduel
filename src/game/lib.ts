import type { Account, Candle, Coin } from '../../shared/types';
export const money = (value: number, digits = 2) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
export const price = (value: number) => !Number.isFinite(value) || value <= 0 ? '—' : money(value, value < 1 ? 5 : value < 10 ? 4 : 2);
export const signed = (value: number) => `${value >= 0 ? '+' : '−'}${money(Math.abs(value))}`;
export const compact = (value: number) => new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
export const shortHash = (value: string) => value ? `${value.slice(0, 7)}…${value.slice(-5)}` : 'Pending';
export const names: Record<Coin, string> = { BTC: 'Bitcoin', ETH: 'Ethereum', SOL: 'Solana', XRP: 'XRP', DOGE: 'Dogecoin', AVAX: 'Avalanche' };
export const emptyAccount = (): Account => ({ cash: 1000, equity: 1000, realizedPnl: 0, unrealizedPnl: 0, fees: 0, reservedMargin: 0, availableMargin: 1000, peakEquity: 1000, maxDrawdown: 0, score: 0, disabled: false, positions: [], nonce: 0 });
export function aggregateCandles(candles: Candle[], minutes: number): Candle[] {
  if (minutes === 1) return candles;
  const result: Candle[] = [];
  for (const c of candles) {
    const time = Math.floor(c.time / (minutes * 60)) * minutes * 60;
    const last = result[result.length - 1];
    if (last?.time === time) { last.high = Math.max(last.high, c.high); last.low = Math.min(last.low, c.low); last.close = c.close; last.volume += c.volume; }
    else result.push({ ...c, time });
  }
  return result;
}
export function downloadJSON(value: unknown, filename: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function useStorageValue<T>(key: string, initial: T): T {
  try { return JSON.parse(localStorage.getItem(key) ?? 'null') ?? initial; } catch { return initial; }
}
