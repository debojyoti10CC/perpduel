import { ArrowUpRight } from 'lucide-react';
import type { Coin, Market } from '../../../shared/types';
import { dayTrend, dayTrendScale, type DayTrend } from '../marketHistory';
import { compact, names, price } from '../lib';
import CoinIcon from './CoinIcon';

export function MarketSparkline({ trend, scale }: { trend: DayTrend; scale: number }) {
  const { points: samples, coin } = trend;
  if (samples.length < 2) return <span className="token-trend-empty" title={`Loading ${coin} 24-hour history`}>—</span>;
  const y = (value: number) => 36 - value / scale * 30;
  const x = (time: number) => 4 + (time - trend.start) / (trend.end - trend.start) * 212;
  const points = samples.map(point => `${x(point.time)},${y(point.percent)}`).join(' ');
  const last = samples.at(-1)!;
  const up = last.percent >= 0;
  return <svg className={`token-sparkline ${up ? 'positive' : 'negative'}`} data-coin={coin} data-samples={samples.length} data-scale-percent={scale} viewBox="0 0 220 72" preserveAspectRatio="none" role="img" aria-label={`${coin} 24-hour return, ${samples.length} native 15-minute samples, shared percentage scale`}>
    <title>{coin} · 24h · 15m samples · shared ±{scale}% scale · latest {last.percent >= 0 ? '+' : ''}{last.percent.toFixed(2)}%</title>
    <line x1="4" y1="36" x2="216" y2="36" stroke="#d9d9e1" strokeWidth="1" strokeDasharray="3 3" vectorEffect="non-scaling-stroke"/>
    <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.7" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round"/>
    <circle cx={x(last.time)} cy={y(last.percent)} r="2.4" fill="currentColor"/>
  </svg>;
}

export default function MarketHighlights({ markets, onSelect, now }: { markets: Market[]; onSelect: (coin: Coin) => void; now: number }) {
  const known = markets.filter(market => market.mark > 0 && Number.isFinite(market.mark));
  const trends = new Map(known.map(market => [market.coin, dayTrend(market, now)]));
  const scale = dayTrendScale([...trends.values()]);
  const active = [...known].sort((a, b) => b.volume24h - a.volume24h)[0];
  const mover = [...known].sort((a, b) => Math.abs(b.change24h) - Math.abs(a.change24h))[0];
  const sol = known.find(market => market.coin === 'SOL');
  const highlights = [
    { title: 'Most active (24h)', market: active, detail: active?.volume24h ? `$${compact(active.volume24h)} volume` : 'Volume unavailable' },
    { title: 'Largest move (24h)', market: mover, detail: mover ? `${mover.change24h >= 0 ? '+' : ''}${mover.change24h.toFixed(2)}% in 24h` : 'Change unavailable' },
    { title: 'Solana spotlight', market: sol, detail: 'Same feed. Same rules. Your move.' },
  ];
  return <section className="market-highlights" aria-label="Live market highlights">{highlights.map(({ title, market, detail }) => <button className="market-highlight" type="button" key={title} disabled={!market} onClick={() => market && onSelect(market.coin)}>
    <div className="market-highlight-top"><span className="highlight-label">{title}</span><ArrowUpRight size={16}/></div>
    <div className="highlight-chart">{market ? <MarketSparkline trend={trends.get(market.coin)!} scale={scale}/> : <span className="highlight-waiting">Waiting for 24h history</span>}</div>
    <div className="highlight-details"><span className="highlight-asset">{market && <CoinIcon coin={market.coin}/>}<strong>{market ? names[market.coin] : 'Market unavailable'}</strong></span><span className="highlight-value">{price(market?.mark ?? 0)}</span></div>
    <div className="highlight-caption"><span>{detail}</span><span className={market?.available ? 'highlight-live' : ''}>{market?.available ? 'Live' : market ? 'Stale' : 'Connecting'}</span></div>
  </button>)}</section>;
}
