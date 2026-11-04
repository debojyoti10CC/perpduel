import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Search, X } from 'lucide-react';
import { COINS, type Coin, type Market } from '../../../shared/types';
import { names, price } from '../lib';
import CoinIcon from './CoinIcon';
import Modal from './Modal';

interface MarketSearchProps {
  open: boolean;
  markets: Market[];
  onClose: () => void;
  onSelect: (coin: Coin) => void;
}

export default function MarketSearch({ open, markets, onClose, onSelect }: MarketSearchProps) {
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    setQuery('');
    const frame = requestAnimationFrame(() => input.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);
  if (!open) return null;
  const normalized = query.trim().toLowerCase().replace(/^\$/, '');
  const matches = COINS.filter(coin => `${coin} ${names[coin]}`.toLowerCase().includes(normalized));
  const choose = (coin: Coin) => { onClose(); onSelect(coin); };
  return <Modal title="Find your market" subtitle="Six live perpetual markets. Every player gets the same feed." onClose={onClose}>
    <form className="token-search-dialog" onSubmit={event => { event.preventDefault(); if (matches[0]) choose(matches[0]); }}>
      <div className="token-search-input-wrap">
        <Search size={20} />
        <input ref={input} className="token-search-input" aria-label="Search markets" placeholder="Search by name or symbol" value={query} onChange={event => setQuery(event.target.value)} autoComplete="off" spellCheck={false} />
        {query && <button className="icon-button" type="button" aria-label="Clear market search" onClick={() => { setQuery(''); input.current?.focus(); }}><X size={16}/></button>}
      </div>
      <div className="token-search-results">
        {matches.length ? matches.map(coin => {
          const market = markets.find(item => item.coin === coin);
          return <button className="token-search-row" type="button" key={coin} onClick={() => choose(coin)} aria-label={`View ${names[coin]} market`}>
            <CoinIcon coin={coin}/>
            <span className="token-search-identity"><strong>{names[coin]}</strong><small>${coin} · Perpetual</small></span>
            <span className="token-search-quote"><strong>{price(market?.mark ?? 0)}</strong><small>{market?.available ? 'Live quote' : market?.mark ? 'Quote stale' : 'Connecting'}</small></span>
            <ArrowUpRight size={16}/>
          </button>;
        }) : <div className="token-search-empty"><Search size={27}/><strong>No matching market</strong><p>Try Bitcoin, Ethereum, Solana, XRP, Dogecoin, or Avalanche.</p></div>}
      </div>
      <div className="token-search-footer"><span aria-live="polite">{matches.length} of 6 markets</span><span><kbd>Enter</kbd> to open · <kbd>Esc</kbd> to close</span></div>
    </form>
  </Modal>;
}
