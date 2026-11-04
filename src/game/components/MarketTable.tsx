import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, ArrowUpRight } from 'lucide-react';
import { COINS, type Coin, type Market, type Player } from '../../../shared/types';
import { compact, names, price } from '../lib';
import CoinIcon from './CoinIcon';
import MarketPositionMarkers, { marketPositionLabel, type PositionsByMarket } from './MarketPositionMarkers';
import { MarketSparkline } from './MarketHighlights';
import { dayTrend, dayTrendScale } from '../marketHistory';

type SortKey = 'name' | 'price' | 'change' | 'volume';
interface Props { markets: Market[]; players?: Player[]; positionsByMarket?: PositionsByMarket; onSelect: (coin: Coin) => void; now: number }

export default function MarketTable({ markets, players = [], positionsByMarket = {}, onSelect, now }: Props) {
  const [sort, setSort] = useState<{ key: SortKey; direction: 'asc' | 'desc' } | null>(null);
  const trends = new Map(markets.map(market => [market.coin, dayTrend(market, now)]));
  const scale = dayTrendScale([...trends.values()]);
  const rows = useMemo(() => {
    const result = COINS.map(coin => ({ coin, market: markets.find(market => market.coin === coin) }));
    if (!sort) return result;
    return result.sort((a, b) => {
      const direction = sort.direction === 'asc' ? 1 : -1;
      if (sort.key === 'name') return direction * names[a.coin].localeCompare(names[b.coin]);
      const value = (market: Market | undefined) => {
        if (!market || market.mark <= 0) return null;
        return sort.key === 'price' ? market.mark : sort.key === 'change' ? market.change24h : market.volume24h;
      };
      const av = value(a.market), bv = value(b.market);
      if (av === null) return bv === null ? 0 : 1;
      if (bv === null) return -1;
      return direction * (av - bv);
    });
  }, [markets, sort]);
  const orderBy = (key: SortKey) => setSort(previous => ({ key, direction: previous?.key === key && previous.direction === 'asc' ? 'desc' : 'asc' }));
  const header = (key: SortKey, label: string) => <th scope="col" aria-sort={sort?.key === key ? sort.direction === 'asc' ? 'ascending' : 'descending' : 'none'}><button type="button" onClick={() => orderBy(key)}>{label}{sort?.key === key ? sort.direction === 'asc' ? <ArrowUp size={13}/> : <ArrowDown size={13}/> : <ArrowUpDown size={12}/>}</button></th>;
  return <div className="token-market-table table-scroll"><table aria-label="Live perpetual market list"><thead><tr>{header('name', 'Market name')}{header('price', 'Mark price')}{header('change', '24h')}<th scope="col" title={`Native 15-minute samples from each coin's last 24 hours. All rows use the same ±${scale}% scale; dashed line is 0%.`}>24h trend <small>same % scale</small></th>{header('volume', '24h volume')}<th scope="col">Players / feed</th></tr></thead><tbody>{rows.map(({ coin, market }) => {
    const fresh = Boolean(market?.available && market.time <= now && now - market.time <= 5000);
    const selected = players.flatMap((player, seat) => player.selected === COINS.indexOf(coin) ? [seat] : []);
    const positions = positionsByMarket[coin] ?? [];
    return <tr key={coin} data-market={coin} className={`${selected.includes(0) ? 'token-row-p1 ' : ''}${selected.includes(1) ? 'token-row-p2' : ''}`}>
      <td><button className="token-name-cell" type="button" onClick={() => onSelect(coin)} aria-label={marketPositionLabel(`View ${names[coin]} market`, positions)}>
        <CoinIcon coin={coin} />
        <span>
          <span className="market-symbol-line">
            <strong className="token-market-name">{names[coin]}</strong>
            <MarketPositionMarkers positions={positions} />
          </span>
          <small className="token-market-symbol">${coin} <span>PERP</span></small>
        </span>
      </button></td>
      <td className={`token-price-cell${fresh ? '' : ' token-price-stale'}`}>{price(market?.mark ?? 0)}</td>
      <td><span className={`token-change${fresh ? (market!.change24h >= 0 ? ' positive' : ' negative') : ''}`}>{fresh ? <>{market!.change24h >= 0 ? '▴' : '▾'} {Math.abs(market!.change24h).toFixed(2)}%</> : '—'}</span></td>
      <td className="token-trend"><MarketSparkline trend={trends.get(coin) ?? {coin,start:now/1000-86400,end:now/1000,points:[]}} scale={scale}/></td>
      <td className="token-volume-cell">{market?.volume24h && market.volume24h > 0 ? `$${compact(market.volume24h)}` : '—'}</td>
      <td><span className="token-player-badges">{selected.map(seat => <span className={`selection-pill p${seat + 1}`} key={seat}>P{seat + 1}</span>)}<span className={`token-live-tag${fresh ? ' is-live' : ''}`}><i/>{fresh ? 'Live' : market?.mark ? 'Stale' : 'Connecting'}</span><button className="token-row-open icon-button" aria-label={`Expand ${coin} market from list`} onClick={() => onSelect(coin)}><ArrowUpRight size={15}/></button></span></td>
    </tr>;
  })}</tbody></table></div>;
}
