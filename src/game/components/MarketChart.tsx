import { useMemo, useState } from 'react';
import { Liveline, type HoverPoint } from 'liveline';
import type { Market } from '../../../shared/types';
import { liveChartData } from '../liveChart';
import { price } from '../lib';

export default function MarketChart({ market, minutes = 1, expanded = false, now = Date.now() }: { market: Market; minutes?: number; expanded?: boolean; now?: number }) {
  const [hover, setHover] = useState<HoverPoint | null>(null);
  const chart = useMemo(() => liveChartData(market, minutes, now), [market, minutes, now]);
  const latest = chart.data.at(-1)?.value ?? market.mark;
  const first = chart.data[0]?.value ?? latest;
  const color = latest > first ? '#4bd9ac' : latest < first ? '#ee8ba5' : '#b18bff';
  const fresh = market.available && market.time > 0 && market.time <= now && now - market.time <= 5_000;
  const timeLabel = (time: number) => new Intl.DateTimeFormat(undefined, { minute: '2-digit', second: '2-digit' }).format(new Date(time * 1000));

  return <div
    className={`market-chart${expanded ? ' expanded-chart' : ''}`}
    data-renderer="liveline"
    data-window-seconds={chart.windowSeconds}
    data-point-count={chart.data.length}
    data-history-points={chart.historicSamples}
    data-live-points={chart.liveSamples}
    data-window-start={chart.data[0]?.time}
    data-window-end={chart.data.at(-1)?.time}
    aria-label={`${market.coin} live price, last ${minutes} minute${minutes === 1 ? '' : 's'}`}
  >
    {chart.data.length < 2 ? <div className="chart-warming" role="status">Waiting for live prices</div> : <Liveline
      data={chart.data}
      value={latest}
      window={chart.windowSeconds}
      mode="line"
      theme="dark"
      color={color}
      grid={expanded}
      fill
      momentum
      badge={false}
      showValue={false}
      scrub={expanded}
      paused={!fresh || (expanded && hover !== null)}
      exaggerate
      pulse={false}
      lineWidth={expanded ? 2.1 : 2.4}
      padding={expanded ? { top: 12, right: 64, bottom: 25, left: 12 } : { top: 5, right: 8, bottom: 8, left: 8 }}
      formatValue={price}
      formatTime={expanded ? timeLabel : () => ''}
      tooltipOutline={false}
      tooltipY={expanded ? undefined : -1000}
      onHover={expanded ? setHover : undefined}
      cursor={expanded ? 'crosshair' : 'default'}
      style={{ width: '100%', height: '100%', display: 'block' }}
    />}
  </div>;
}
