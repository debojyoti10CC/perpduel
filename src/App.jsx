import { useEffect, useId, useRef, useState } from 'react';
import FaultyTerminal from './components/FaultyTerminal.jsx';
import AssetPicker from './components/AssetPicker.jsx';
import useTokenUsd from './hooks/useTokenUsd.js';

const ASSETS = ['MON', 'SOL', 'ETH'];
const INITIAL_DUELS = [
  { id: 'd1', address: '0x33a9…8f2e', asset: 'MON', amount: 10, duration: '5 min', side: 'long', avatar: 0, wins: 72 },
  { id: 'd2', address: '0x97c2…1a4d', asset: 'SOL', amount: 0.03, duration: '15 min', side: 'short', avatar: 1, wins: 68 },
  { id: 'd3', address: '0x44b8…9c7f', asset: 'MON', amount: 25, duration: '5 min', side: 'short', avatar: 2, wins: 81 },
  { id: 'd4', address: '0x82e1…3b6a', asset: 'ETH', amount: 0.003, duration: '15 min', side: 'long', avatar: 3, wins: 64 },
  { id: 'd5', address: '0x6f09…2d8c', asset: 'SOL', amount: 0.7, duration: '30 min', side: 'long', avatar: 4, wins: 76 },
];
const round = n => Number(n.toFixed(6));
const formatAmount = n => new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 }).format(n);
const formatUsd = n => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: n >= 1_000_000 ? 'compact' : 'standard', minimumFractionDigits: 2, maximumFractionDigits: n > 0 && n < 0.01 ? 6 : 2 }).format(n);
const WALLET = '0x8f4a…92b1';

function Icon({ name, size = 20, ...props }) {
  const paths = {
    arrow: <><path d="M5 12h14M12 5l7 7-7 7" /></>,
    chevron: <path d="m6 9 6 6 6-6" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    plus: <path d="M12 5v14M5 12h14" />,
    check: <path d="m5 12 4 4L19 6" />,
    wallet: <><path d="M19 8V5a2 2 0 0 0-2-2H5a3 3 0 0 0 0 6h15v11H5a3 3 0 0 1-3-3V6" /><path d="M20 12h-5v5h5M16 14.5h.01" /></>,
    external: <><path d="M14 3h7v7M21 3 10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5" /></>,
    time: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[name]}</svg>;
}

function BrandMark({ size = 29 }) {
  return <svg width={size} height={size} viewBox="0 0 36 36" fill="none" aria-hidden="true"><circle cx="18" cy="18" r="13.8" stroke="currentColor" strokeWidth="1.5" /><path d="m18 1.9 16.1 16.1L18 34.1 1.9 18Z" stroke="currentColor" strokeWidth="1.5" /><path d="m18 9.3 8.7 8.7-8.7 8.7L9.3 18Z" fill="currentColor" /></svg>;
}

function Token({ asset, size = 24 }) {
  return <span className={`token token-${asset.toLowerCase()}`} style={{ width: size, height: size }} aria-hidden="true">{asset === 'MON' ? <svg viewBox="0 0 24 24" width={size * .75} height={size * .75} fill="none"><path d="M12 3C8 3 3 8 3 12s5 9 9 9 9-5 9-9-5-9-9-9Zm0 4 5 5-5 5-5-5 5-5Z" fill="currentColor" fillRule="evenodd" /></svg> : asset === 'SOL' ? <svg viewBox="0 0 24 24" width={size * .66} height={size * .66}><path d="m5 4-3 4h17l3-4ZM2 10l3 4h17l-3-4Zm3 6-3 4h17l3-4Z" fill="currentColor" /></svg> : <svg viewBox="0 0 24 24" width={size * .75} height={size * .75} fill="currentColor"><path opacity=".7" d="m12 1-7 11 7 4 7-4Z" /><path d="m5 14 7 9 7-9-7 4Z" /></svg>}</span>;
}

function Modal({ title, children, onClose, className = '' }) {
  const titleId = useId();
  const dialogRef = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    const dialog = dialogRef.current;
    dialog.showModal();
    return () => { dialog.close(); previous?.focus?.(); };
  }, []);
  return <dialog ref={dialogRef} className={`modal ${className}`} aria-labelledby={titleId} onCancel={onClose} onClick={e => { if (e.target === e.currentTarget) { const r = e.currentTarget.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) onClose(); } }}>
    <div className="modal-header"><h2 id={titleId}>{title}</h2><button className="icon-button" aria-label="Close dialog" onClick={onClose}><Icon name="close" /></button></div>
    {children}
  </dialog>;
}

function AssetSelect({ asset, onChange, label = 'Deposit currency' }) {
  return <AssetPicker value={asset} onChange={onChange} label={label} renderToken={(token, size) => <Token asset={token} size={size} />} />;
}

function Avatar({ variant = 0 }) {
  return <span className={`avatar avatar-${variant % 5}`} aria-hidden="true"><span /><i /></span>;
}

export default function App() {
  const [asset, setAsset] = useState('MON');
  const [amount, setAmount] = useState('');
  const [wallet, setWallet] = useState(false);
  const [balances, setBalances] = useState({ MON: 0, SOL: 0, ETH: 0 });
  const [duels, setDuels] = useState(INITIAL_DUELS);
  const [joined, setJoined] = useState([]);
  const [tab, setTab] = useState('open');
  const [filter, setFilter] = useState('All tokens');
  const [sort, setSort] = useState('Newest first');
  const [modal, setModal] = useState(null);
  const [pendingAction, setPendingAction] = useState(null);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [createAmount, setCreateAmount] = useState('10');
  const [createAsset, setCreateAsset] = useState('MON');
  const [duration, setDuration] = useState('5 min');
  const [side, setSide] = useState('long');
  const amountRef = useRef(null);
  const lobbyRef = useRef(null);
  const { price: usdPrice, loading: priceLoading, updatedAt: priceUpdatedAt } = useTokenUsd(asset);
  const numericAmount = Number(amount) || 0;
  const usdValue = numericAmount === 0 ? '$0.00' : usdPrice !== null ? `≈ ${formatUsd(numericAmount * usdPrice)}` : priceLoading ? 'Pricing…' : 'USD unavailable';
  const usdTooltip = usdPrice !== null ? `1 ${asset} ≈ ${formatUsd(usdPrice)} · CoinGecko market estimate · Updated ${new Date(priceUpdatedAt).toLocaleTimeString()}` : 'A current market price is unavailable. The token amount is unchanged.';

  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 4800); return () => clearTimeout(timer); }, [toast]);
  const closeModal = () => { setModal(null); setError(''); setPendingAction(null); };
  const showModal = next => { setError(''); setModal(next); };
  const handleTabKey = event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'open' : event.key === 'End' ? 'mine' : tab === 'open' ? 'mine' : 'open';
    setTab(next);
    document.getElementById(`${next}-tab`)?.focus();
  };
  const requireWallet = action => { if (!wallet) { setPendingAction(action); showModal('wallet'); } else showModal(action); };
  const connect = () => { setWallet(true); setModal(pendingAction); setPendingAction(null); setToast('Demo wallet connected. Make a deposit to get started.'); };
  const startDeposit = event => {
    event.preventDefault();
    if (!Number.isFinite(Number(amount)) || Number(amount) <= 0 || Number(amount) > 1000000 || round(Number(amount)) === 0) {
      setError('Enter an amount between 0.000001 and 1,000,000.'); amountRef.current?.focus(); return;
    }
    setError(''); requireWallet('deposit');
  };
  const deposit = () => {
    setBalances(previous => ({ ...previous, [asset]: round(previous[asset] + Number(amount)) }));
    setToast(`${formatAmount(Number(amount))} ${asset} added to your demo balance.`); setAmount(''); closeModal();
  };
  const joinDuel = duel => {
    if (balances[duel.asset] < duel.amount) { setError(`Deposit ${formatAmount(duel.amount - balances[duel.asset])} more ${duel.asset} to join this duel.`); return; }
    setBalances(b => ({ ...b, [duel.asset]: round(b[duel.asset] - duel.amount) })); setJoined(ids => [...ids, duel.id]);
    closeModal(); setToast('You joined the demo duel. Find it in My duels.');
  };
  const createDuel = event => {
    event.preventDefault();
    const stake = round(Number(createAmount));
    if (!Number.isFinite(stake) || stake <= 0 || stake > 1000000) { setError('Enter a valid stake between 0.000001 and 1,000,000.'); return; }
    if (balances[createAsset] < stake) { setError(`Deposit ${formatAmount(stake - balances[createAsset])} more ${createAsset} to create this duel.`); return; }
    setBalances(b => ({ ...b, [createAsset]: round(b[createAsset] - stake) }));
    setDuels(list => [{ id: crypto.randomUUID(), address: WALLET, asset: createAsset, amount: stake, duration, side, avatar: 3, wins: 0, own: true }, ...list]);
    setTab('mine'); setFilter('All tokens'); closeModal(); setToast('Your demo duel is open. Waiting for a challenger.');
  };
  const visibleDuels = duels.filter(d => tab === 'mine' ? d.own || joined.includes(d.id) : !d.own && !joined.includes(d.id)).filter(d => filter === 'All tokens' || d.asset === filter);
  if (sort === 'Shortest first') visibleDuels.sort((a, b) => parseInt(a.duration) - parseInt(b.duration));
  const openCount = duels.filter(d => !d.own && !joined.includes(d.id)).length;
  const mineCount = duels.filter(d => d.own || joined.includes(d.id)).length;
  const selectedDuel = typeof modal === 'object' ? modal : null;

  return <>
    <div className="terminal-background" aria-hidden="true">
      <FaultyTerminal tint="#7c3aed" glyphs="blocks" scale={2.9} digitSize={1.2} timeScale={0.5} brightness={0.6} glow={0} persistence={0} mouseStrength={0.5} mouseGlow={0} curvature={0} vignette={0} clickEffect="none" dpr={1} />
    </div>
    <div className="page-gradient" />
    <header className="site-header">
      <a className="brand" href="#" aria-label="PERPDUEL home" onClick={() => { setTab('open'); setFilter('All tokens'); }}><BrandMark /><span>PERPDUEL</span></a>
      <nav aria-label="Main navigation"><button className="text-button how-it-works" onClick={() => showModal('rules')}>How it works <Icon name="external" size={13} /></button><button className={`wallet-button ${wallet ? 'connected' : ''}`} onClick={() => showModal(wallet ? 'account' : 'wallet')}>{wallet && <span className="connection-dot" />}{wallet ? WALLET : 'Connect wallet'}</button></nav>
    </header>

    <main>
      <section className="hero" aria-labelledby="deposit-title">
        <h1 id="deposit-title">Deposit</h1>
        <form className={`deposit-form ${error && !modal ? 'has-error' : ''}`} onSubmit={startDeposit}>
          <input ref={amountRef} aria-label="Deposit amount" aria-describedby="deposit-help" inputMode="decimal" type="text" placeholder="Enter amount" value={amount} onChange={e => { if (/^\d*\.?\d{0,6}$/.test(e.target.value)) { setAmount(e.target.value); setError(''); } }} />
          <output className={`deposit-usd ${numericAmount > 0 && usdPrice === null ? 'is-unavailable' : ''}`} aria-label="Estimated dollar value" aria-live="polite" title={usdTooltip}>{usdValue}</output>
          <AssetSelect asset={asset} onChange={next => { setAsset(next); setError(''); }} />
          <button className="deposit-submit" type="submit" aria-label={`Deposit ${asset}`}><Icon name="arrow" size={27} /></button>
        </form>
        <p className={`deposit-help ${error && !modal ? 'error' : ''}`} id="deposit-help" aria-live="polite">{error && !modal ? error : wallet ? <>Available balance <strong>{formatAmount(balances[asset])} {asset}</strong><span className="help-dot">·</span>Demo wallet</> : <>Choose your stake. Find your opponent.</>}</p>
      </section>

      <section className="lobby content-width" aria-labelledby="duels-title" ref={lobbyRef}>
        <div className="lobby-toolbar">
          <div className="tabs" role="tablist" aria-label="Duel lists"><button id="open-tab" role="tab" tabIndex={tab === 'open' ? 0 : -1} onKeyDown={handleTabKey} aria-selected={tab === 'open'} aria-controls="duel-panel" className={tab === 'open' ? 'active' : ''} onClick={() => setTab('open')}>Open duels <span>{openCount}</span></button><button id="mine-tab" role="tab" tabIndex={tab === 'mine' ? 0 : -1} onKeyDown={handleTabKey} aria-selected={tab === 'mine'} aria-controls="duel-panel" className={tab === 'mine' ? 'active' : ''} onClick={() => setTab('mine')}>My duels {mineCount > 0 && <span>{mineCount}</span>}</button></div>
          <button className="create-button" onClick={() => requireWallet('create')}><Icon name="plus" size={17} />Create duel</button>
        </div>
        <div id="duel-panel" className="duel-panel" role="tabpanel" aria-labelledby={tab === 'open' ? 'open-tab' : 'mine-tab'}>
          <div className="table-toolbar"><h2 id="duels-title"><span className="live-dot" />{tab === 'open' ? 'Find your next opponent' : 'Your arena'}</h2><div className="table-filters"><div className="select-wrap"><select value={filter} onChange={e => setFilter(e.target.value)} aria-label="Filter by token"><option>All tokens</option>{ASSETS.map(a => <option key={a}>{a}</option>)}</select><Icon name="chevron" size={13} /></div><span className="filter-divider" /><div className="select-wrap sort-select"><select value={sort} onChange={e => setSort(e.target.value)} aria-label="Sort duels"><option>Newest first</option><option>Shortest first</option></select><Icon name="chevron" size={13} /></div></div></div>
          <div className="duel-head"><span>Trader</span><span>Entry stake</span><span>Position</span><span>Duration</span><span className="right-align">Prize pool</span><span /></div>
          <div className="duel-rows">{visibleDuels.map(duel => <div className="duel-row" key={duel.id}>
            <div className="trader"><Avatar variant={duel.avatar} /><div><span className="trader-address">{duel.own ? 'You' : duel.address}</span><span className="trader-meta">{duel.own ? 'Waiting for challenger' : `${duel.wins}% win rate`}</span></div></div>
            <div className="stake-cell"><Token asset={duel.asset} size={23} /><span>{formatAmount(duel.amount)} <span className="currency-label">{duel.asset}</span></span></div>
            <div className="position-cell"><span className={`position ${duel.side}`}>{duel.side === 'long' ? '↗' : '↘'} {duel.side === 'long' ? 'Long' : 'Short'}</span><span className="versus">vs</span><span className="open-position">?</span></div>
            <div className="duration-cell"><Icon name="time" size={14} /><span>{duel.duration}</span></div>
            <div className="prize-cell">{formatAmount(round(duel.amount * 2))}<span>{duel.asset}</span></div>
            <button className={`join-button ${duel.own || joined.includes(duel.id) ? 'joined' : ''}`} onClick={() => requireWallet(duel)}>{duel.own ? 'Waiting' : joined.includes(duel.id) ? 'Joined' : 'Join duel'}{duel.own ? <span className="waiting-dot" /> : joined.includes(duel.id) ? <Icon name="check" size={15} /> : <Icon name="arrow" size={16} />}</button>
          </div>)}</div>
          {visibleDuels.length === 0 && <div className="empty-state"><BrandMark size={35} /><h3>{tab === 'mine' ? 'Your first duel is waiting.' : 'A clear arena.'}</h3><p>{tab === 'mine' ? 'Join an open duel or create one of your own.' : 'No open duels for this token. Start the first one.'}</p><button className="black-button" onClick={() => tab === 'mine' ? (setTab('open'), setFilter('All tokens')) : requireWallet('create')}>{tab === 'mine' ? 'Explore open duels' : 'Create duel'}<Icon name="arrow" size={16} /></button></div>}
          <div className="table-footer"><span>Equal stakes. Opposite positions. One winner.</span><span><span className="mini-dot" />Demo arena</span></div>
        </div>
      </section>
    </main>

    <footer className="site-footer content-width"><a className="footer-brand" href="#"><BrandMark size={20} />PERPDUEL</a><span>Trading, head to head.</span><div><span className="demo-label">Interactive demo</span><button onClick={() => showModal('rules')}>How it works <Icon name="external" size={12} /></button></div></footer>

    {modal === 'wallet' && <Modal title="Connect to PERPDUEL" onClose={closeModal}><div className="modal-brand"><BrandMark size={43} /></div><p className="modal-copy">Your next rivalry starts here. Explore deposits and duels with a demo wallet.</p><button className="wallet-option" onClick={connect}><span className="wallet-option-icon"><Icon name="wallet" size={23} /></span><span><strong>Demo wallet</strong><small>No extension or funds needed</small></span><Icon name="arrow" size={19} /></button><p className="modal-footnote">This front-page preview uses simulated funds. Connecting does not access a real wallet.</p></Modal>}

    {modal === 'deposit' && <Modal title="Confirm deposit" onClose={closeModal}><p className="modal-copy">Add to your demo balance and enter the arena.</p><div className="deposit-confirm"><Token asset={asset} size={38} /><span>{formatAmount(Number(amount))} <span>{asset}</span></span></div><dl className="summary"><div><dt>Wallet</dt><dd>{WALLET}</dd></div><div><dt>New balance</dt><dd>{formatAmount(round(balances[asset] + Number(amount)))} {asset}</dd></div><div><dt>Network</dt><dd>Demo arena</dd></div></dl><button className="black-button full-width" onClick={deposit}>Confirm demo deposit<Icon name="arrow" size={18} /></button><p className="modal-footnote">Simulated deposit. No funds will be transferred.</p></Modal>}

    {modal === 'account' && <Modal title="Your wallet" onClose={closeModal}><div className="account-id"><span className="connection-dot" />{WALLET}<span className="demo-label">Demo</span></div><dl className="balance-list">{ASSETS.map(a => <div key={a}><dt><Token asset={a} />{a}</dt><dd>{formatAmount(balances[a])}</dd></div>)}</dl><button className="black-button full-width" onClick={() => { closeModal(); requestAnimationFrame(() => amountRef.current?.focus()); }}>Make a deposit<Icon name="arrow" size={18} /></button><button className="disconnect-button" onClick={() => { setWallet(false); closeModal(); setToast('Wallet disconnected. Your demo balance stays for this session.'); }}>Disconnect wallet</button></Modal>}

    {modal === 'rules' && <Modal title="Trading, head to head." onClose={closeModal}><p className="modal-copy">One market. Two traders. Back your conviction.</p><ol className="rules-list"><li><span>01</span><div><h3>Deposit your stake</h3><p>Choose MON, SOL, or ETH and add to your arena balance.</p></div></li><li><span>02</span><div><h3>Find your opponent</h3><p>Join a duel at an equal stake. You take the opposite position, or create your own matchup.</p></div></li><li><span>03</span><div><h3>Take the win</h3><p>The better position at the end of the round wins the combined prize pool.</p></div></li></ol><p className="info-note">This is an interactive front-page demo. Balances, opponents, and stakes are simulated; live trading and settlement are not connected.</p><button className="black-button full-width" onClick={() => { closeModal(); lobbyRef.current?.scrollIntoView({ behavior: 'smooth' }); }}>Explore the arena<Icon name="arrow" size={18} /></button></Modal>}

    {modal === 'create' && <Modal title="Create a duel" onClose={closeModal}><p className="modal-copy">Set the stakes. Let someone take the other side.</p><form onSubmit={createDuel}><label className="field-label" htmlFor="create-stake">Entry stake</label><div className="create-stake"><input id="create-stake" inputMode="decimal" value={createAmount} onChange={e => { if (/^\d*\.?\d{0,6}$/.test(e.target.value)) { setCreateAmount(e.target.value); setError(''); } }} /><AssetSelect asset={createAsset} onChange={a => { setCreateAsset(a); setError(''); }} label="Duel currency" /></div><p className="field-help">Available: {formatAmount(balances[createAsset])} {createAsset}</p><label className="field-label" htmlFor="duel-duration">Round duration</label><select className="form-select" id="duel-duration" value={duration} onChange={e => setDuration(e.target.value)}><option>5 min</option><option>15 min</option><option>30 min</option></select><span className="field-label">Your position</span><div className="side-options"><button type="button" className={side === 'long' ? 'chosen long' : ''} aria-pressed={side === 'long'} onClick={() => setSide('long')}>↗ Long</button><button type="button" className={side === 'short' ? 'chosen short' : ''} aria-pressed={side === 'short'} onClick={() => setSide('short')}>↘ Short</button></div>{error && <p className="form-error" role="alert">{error}</p>}<button className="black-button full-width" type="submit">Create demo duel<Icon name="arrow" size={18} /></button><p className="modal-footnote">Your demo stake will be reserved from your balance.</p></form></Modal>}

    {selectedDuel && <Modal title={selectedDuel.own ? 'Your duel is open' : joined.includes(selectedDuel.id) ? 'You’re in the duel' : 'Meet your opponent'} onClose={closeModal}><div className="match-preview"><div><Avatar variant={selectedDuel.avatar} /><strong>{selectedDuel.own ? 'You' : selectedDuel.address}</strong><span className={`position ${selectedDuel.side}`}>{selectedDuel.side === 'long' ? '↗ Long' : '↘ Short'}</span></div><span className="match-vs">vs</span><div><span className="avatar challenger"><BrandMark size={25} /></span><strong>{selectedDuel.own ? 'Challenger' : 'You'}</strong><span className={`position ${selectedDuel.side === 'long' ? 'short' : 'long'}`}>{selectedDuel.side === 'long' ? '↘ Short' : '↗ Long'}</span></div></div><dl className="summary"><div><dt>Entry stake</dt><dd>{formatAmount(selectedDuel.amount)} {selectedDuel.asset}</dd></div><div><dt>Prize pool</dt><dd>{formatAmount(round(selectedDuel.amount * 2))} {selectedDuel.asset}</dd></div><div><dt>Round duration</dt><dd>{selectedDuel.duration}</dd></div><div><dt>Your balance</dt><dd>{formatAmount(balances[selectedDuel.asset])} {selectedDuel.asset}</dd></div></dl>{error && <p className="form-error" role="alert">{error}</p>}{selectedDuel.own || joined.includes(selectedDuel.id) ? <p className="info-note">{selectedDuel.own ? 'Your demo stake is reserved. This preview does not match live opponents.' : 'Your demo stake is reserved. Live trading and settlement are not connected.'}</p> : <><button className="black-button full-width" onClick={() => joinDuel(selectedDuel)}>Join demo duel<Icon name="arrow" size={18} /></button>{balances[selectedDuel.asset] < selectedDuel.amount && <button className="deposit-link" onClick={() => { setAsset(selectedDuel.asset); setAmount(String(round(selectedDuel.amount - balances[selectedDuel.asset]))); closeModal(); requestAnimationFrame(() => amountRef.current?.focus()); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>Add {selectedDuel.asset} to your balance<Icon name="arrow" size={14} /></button>}<p className="modal-footnote">Your stake will be reserved from your demo balance.</p></>}</Modal>}

    {toast && <div className="toast" role="status"><span className="toast-check"><Icon name="check" size={15} /></span>{toast}<button aria-label="Dismiss notification" onClick={() => setToast('')}><Icon name="close" size={15} /></button></div>}
  </>;
}
