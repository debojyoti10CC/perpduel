import { useState } from 'react';

const icons: Record<string, string> = {
  BTC: '/token-icons/btc.svg',
  ETH: '/token-icons/eth.svg',
  SOL: '/token-icons/sol.png',
  XRP: '/token-icons/xrp.png',
};
const labels: Record<string, string> = { BTC: '₿', ETH: '♦', SOL: '≋', XRP: '×', DOGE: 'Ð', AVAX: '▲' };

export default function CoinIcon({ coin }: { coin: string }) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const source = icons[coin];
  return <span className={`coin-icon coin-${coin.toLowerCase()}`} aria-hidden="true">
    {source && source !== failedSource ? <img className="coin-logo" src={source} alt="" onError={() => setFailedSource(source)} /> : labels[coin] ?? coin.slice(0, 1)}
  </span>;
}
