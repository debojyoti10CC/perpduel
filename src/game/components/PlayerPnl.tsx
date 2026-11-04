import { useEffect, useId, useState } from 'react';
import { signed } from '../lib';

type Sample = { time: number; value: number };

export default function PlayerPnl({ pnl, elapsedMs }: { pnl: number; elapsedMs: number }) {
  const [history, setHistory] = useState<Sample[]>([{ time: 0, value: 0 }]);
  const colorId = useId();
  const second = Math.max(0, Math.floor(elapsedMs / 1000));

  useEffect(() => {
    if (second === 0) return;
    setHistory(previous => {
      const last = previous.at(-1)!;
      if (last.time > second || (last.time === second && last.value === pnl)) return previous;
      const next = { time: second, value: pnl };
      return last.time === second ? [...previous.slice(0, -1), next] : [...previous, next];
    });
  }, [second, pnl]);

  const samples = [...history.filter(sample => sample.time < second), { time: second, value: pnl }];
  const span = Math.max(second, 12);
  const scale = Math.max(0.25, ...samples.map(sample => Math.abs(sample.value)));
  const points = samples.map(({ time, value }) => [2 + 92 * (span - second + time) / span, 14 - 11 * value / scale]);
  const [endX, endY] = points.at(-1)!;
  const tone = pnl > 0 ? '#4bd9ac' : pnl < 0 ? '#ff91ad' : '#a49aaa';

  return <div className="player-pnl" style={{ color: tone }} title="Net paper P&L, including fees">
    <svg viewBox="0 0 98 28" aria-hidden="true">
      <defs>
        <linearGradient id={colorId} gradientUnits="userSpaceOnUse" x1="0" x2="0" y1="3" y2="25">
          <stop offset="50%" stopColor="#4bd9ac" />
          <stop offset="50%" stopColor="#ff91ad" />
        </linearGradient>
      </defs>
      <path className="player-pnl-zero" d="M2 14H96" />
      <polyline points={points.map(point => point.join(',')).join(' ')} fill="none" stroke={`url(#${colorId})`} strokeWidth="1.65" strokeLinejoin="round" />
      <circle cx={endX} cy={endY} r="2.3" fill="currentColor" />
    </svg>
    <span aria-label={`Net P&L ${signed(pnl)}`}>{signed(pnl)}</span>
  </div>;
}
