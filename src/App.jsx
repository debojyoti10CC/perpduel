import { useCallback, useEffect, useId, useRef, useState } from 'react';
import FaultyTerminal from './components/FaultyTerminal.jsx';
import AssetPicker from './components/AssetPicker.jsx';
import Identicon from './components/Identicon.jsx';
import RoundDurationPicker from './components/RoundDurationPicker.jsx';
import EscrowClaim from './game/components/EscrowClaim.tsx';
import useTokenUsd from './hooks/useTokenUsd.js';
import { copyInviteText, roomInvite } from './game/invite.ts';
import { DEFAULT_ROUND_SECONDS, isRoundDuration } from '../shared/types.ts';

const ASSETS = ['MON', 'SOL', 'ETH'];
const INITIAL_DUELS = [
  { id: 'd1', address: '0x33a9…8f2e', asset: 'MON', amount: 10, duration: '5 min', wins: 72 },
  { id: 'd2', address: '0x97c2…1a4d', asset: 'SOL', amount: 0.03, duration: '3 min', wins: 68 },
  { id: 'd3', address: '0x44b8…9c7f', asset: 'MON', amount: 25, duration: '5 min', wins: 81 },
  { id: 'd4', address: '0x82e1…3b6a', asset: 'ETH', amount: 0.003, duration: '2 min', wins: 64 },
  { id: 'd5', address: '0x6f09…2d8c', asset: 'SOL', amount: 0.7, duration: '4 min', wins: 76 },
];
const DUEL_PHASE_LABELS = {
  registering: 'Setting up',
  countdown: 'Starting soon',
  active: 'In progress',
  settling: 'Settling',
  finished: 'Finished',
  void: 'Voided',
};

function duelStatus(room) {
  if (room.preview) return 'Sample listing';
  if (room.phase !== 'lobby') return DUEL_PHASE_LABELS[room.phase] ?? 'Room';
  if (room.funding && (!room.funding.hostFunded || (room.funding.guestAddress && !room.funding.guestFunded))) {
    return 'Awaiting deposit';
  }
  if (room.players < 2) return room.current ? 'Waiting for opponent' : 'Open seat';
  return 'Waiting for ready';
}
const round = n => Number(n.toFixed(6));
const formatRound = (seconds = DEFAULT_ROUND_SECONDS) => `${seconds / 60} min`;
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

function Modal({ title, children, onClose, className = '', cover }) {
  const titleId = useId();
  const dialogRef = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    const dialog = dialogRef.current;
    dialog.showModal();
    return () => { dialog.close(); previous?.focus?.(); };
  }, []);
  const content = <>
    <div className="modal-header"><h2 id={titleId}>{title}</h2><button className="icon-button" aria-label="Close dialog" onClick={onClose}><Icon name="close" /></button></div>
    {children}
  </>;
  return <dialog ref={dialogRef} className={`modal ${className}`} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose(); }} onClick={e => { if (e.target === e.currentTarget) { const r = e.currentTarget.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) onClose(); } }}>
    {cover ? <>{cover}<div className="modal-card-body">{content}</div></> : content}
  </dialog>;
}

function MatchupCover() {
  return <div className="matchup-cover" aria-hidden="true">
    <span className="matchup-cover-mark"><BrandMark size={20} /></span>
    <span className="matchup-cover-label">PERPDUEL <span>ARENA</span></span>
  </div>;
}

function AssetSelect({ asset, onChange, label = 'Deposit currency' }) {
  return <AssetPicker value={asset} onChange={onChange} label={label} renderToken={(token, size) => <Token asset={token} size={size} />} />;
}

function Avatar({ seed }) { return <Identicon seed={seed} />; }

import { useDuel } from './game/hooks/useDuel';
import * as monadWallet from './hooks/monadWallet.js';
export default function App({ initialSession }) {
  const [session, setSession] = useState(initialSession);
  const [asset, setAsset] = useState('MON');
  const [amount, setAmount] = useState('');
  const [rooms, setRooms] = useState([]);
  const [roomsError, setRoomsError] = useState('');
  const [config, setConfig] = useState(null);
  const [modal, setModal] = useState(new URLSearchParams(location.search).get('room') ? 'matchup' : null);
  const [name, setName] = useState(() => localStorage.getItem('perpduel-name') || '');
  const [roomCode, setRoomCode] = useState(new URLSearchParams(location.search).get('room') || '');
  const [visibility, setVisibility] = useState('public');
  const [roundSeconds, setRoundSeconds] = useState(DEFAULT_ROUND_SECONDS);
  const [practiceRoundSeconds, setPracticeRoundSeconds] = useState(DEFAULT_ROUND_SECONDS);
  const [tab, setTab] = useState('open');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [walletBalance, setWalletBalance] = useState(null);
  const [selectedRoom, setSelectedRoom] = useState(null);
  const [selectedProfile, setSelectedProfile] = useState(null);
  const [settledDuel, setSettledDuel] = useState(null);
  const settledId = new URLSearchParams(location.search).get('settled');
  const amountRef = useRef(null);
  const lastRoom = useRef(null);
  const pending = useRef(null);
  const pendingModal = useRef(null);
  const practiceStarted = useRef(false);
  const { price: usdPrice } = useTokenUsd(asset);
  const numericAmount = Number(amount) || 0;
  const usdValue = numericAmount === 0 ? '$0.00' : usdPrice !== null ? `≈ ${formatUsd(numericAmount * usdPrice)}` : 'USD unavailable';

  const request = useCallback(async (url, body) => {
    const response = await fetch(url, { credentials: 'same-origin', ...(body !== undefined ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || data.message || 'The request could not be completed.');
    return data;
  }, []);
  const notify = useCallback(message => setToast(message), []);
  const onError = useCallback(message => {
    setBusy('');
    if (pending.current === 'join' && message.includes('Sign in with your Monad testnet wallet before joining.')) {
      pending.current = null;
      pendingModal.current = 'matchup';
      setModal('wallet');
      setError('');
      return;
    }
    pending.current = null;
    setError(message);
  }, []);
  const feedback = useCallback(event => { if (event.kind === 'reject') setError(event.message); }, []);
  const duel = useDuel(feedback, onError);
  const { state, seats, connected, send } = duel;
  const walletAddress = session?.walletAddress;
  const shortAddress = address => address ? `${address.slice(0, 6)}…${address.slice(-4)}` : '';
  const closeModal = () => { if (!busy) { setModal(null); setError(''); } };
  const openModal = next => { setError(''); setModal(next); };
  const invoke = async (label, action) => { setError(''); setBusy(label); try { await action(); } catch (cause) { setError(cause.shortMessage || cause.message || 'Please try again.'); } finally { setBusy(''); } };
  const openSettlement = () => {
    setSettledDuel(null);
    openModal('settlement');
    void invoke('settlement', async () => {
      const match = await request(`/api/matches/${encodeURIComponent(settledId)}`);
      if (!match.funding || !['finished', 'void'].includes(match.phase)) throw new Error('No settled testnet duel found.');
      setSettledDuel(match);
    });
  };

  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 5000); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => { localStorage.setItem('perpduel-name', name); }, [name]);
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try { const [listing, escrow] = await Promise.all([request('/api/rooms'), request('/api/escrow/config')]); if (active) { setRooms((listing.rooms || []).filter(room => room.funding?.mode === 'monad-testnet')); setConfig(escrow); setRoomsError(''); } }
      catch { if (active) setRoomsError('The room server is reconnecting.'); }
    };
    refresh(); const timer = setInterval(refresh, 2500);
    return () => { active = false; clearInterval(timer); };
  }, [request]);
  useEffect(() => {
    if (!state) return;
    if (state.id !== lastRoom.current) {
      lastRoom.current = state.id; setBusy('');
      if (state.mode === 'local' && pending.current === 'practice') { location.assign(`/arena?room=${state.code}&bot=1`); return; }
      setModal('waiting'); pending.current = null;
    }
  }, [state]);
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (!connected || !params.has('practice') || practiceStarted.current) return;
    const requestedSeconds = Number(params.get('roundSeconds'));
    practiceStarted.current = true; pending.current = 'practice';
    send({
      type: 'create', mode: 'local', name: name.trim() || 'You', name2: 'Practice Bot',
      roundSeconds: isRoundDuration(requestedSeconds) ? requestedSeconds : DEFAULT_ROUND_SECONDS,
    });
  }, [connected, name, send]);

  const authenticate = async () => {
    const account = await monadWallet.connectMonadWallet();
    const challenge = await request('/api/auth/challenge', { address: account.address });
    const signed = await monadWallet.signWalletNonce(challenge.message);
    const authenticated = await request('/api/auth/verify', { address: signed.address, signature: signed.signature });
    setSession(authenticated); setWalletBalance(account.balance);
    return authenticated;
  };
  const connectWallet = () => invoke('Confirm the connection in your wallet…', async () => { await authenticate(); setModal(pendingModal.current); pendingModal.current = null; notify('Wallet connected to Monad testnet.'); });
  const requireWallet = next => { if (!walletAddress) { pendingModal.current = next; openModal('wallet'); return false; } openModal(next); return true; };
  const beginCreate = event => {
    event?.preventDefault();
    if (state && !['finished', 'void'].includes(state.phase)) { openModal('waiting'); return; }
    if (asset !== 'MON') { setError('Room stakes use test MON on Monad testnet. Choose MON to continue.'); amountRef.current?.focus(); return; }
    if (!(numericAmount > 0) || numericAmount > 1_000_000) { setError('Enter a stake greater than zero, up to 1,000,000 test MON.'); amountRef.current?.focus(); return; }
    requireWallet('create');
  };
  const createRoom = event => {
    event.preventDefault();
    if (!config?.enabled) { openModal('setup'); return; }
    setBusy('Creating your room…'); setError(''); pending.current = 'create';
    if (!send({
      type: 'create', mode: 'online', name: name.trim() || shortAddress(walletAddress),
      stake: { asset: 'MON', amount: numericAmount }, visibility, fundingMode: 'monad-testnet', roundSeconds,
    })) setBusy('');
  };
  const joinRoom = event => {
    event?.preventDefault();
    const code = roomCode.trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) { setError('Enter the six-character room code.'); return; }
    if (selectedRoom?.funding && !walletAddress) { pendingModal.current = 'matchup'; openModal('wallet'); return; }
    setBusy('Joining the room…'); setError(''); pending.current = 'join';
    if (!send({ type: 'join', code, name: name.trim() || shortAddress(walletAddress) || 'Challenger' })) setBusy('');
  };
  const chooseRoom = room => { if (state?.code === room.code) { openModal('waiting'); return; } setSelectedRoom(room); setSelectedProfile(null); setRoomCode(room.code); openModal('matchup'); };
  const chooseProfile = profile => { setSelectedRoom(null); setSelectedProfile(profile); setRoomCode(''); openModal('matchup'); };
  const openRoomJoin = () => { setSelectedRoom(null); setSelectedProfile(null); setRoomCode(''); openModal('matchup'); };
  const setupEscrow = () => invoke('Approve the contract deployment in your wallet…', async () => {
    const account = await authenticate();
    if (!account.walletAddress) throw new Error('Connect a wallet first.');
    const latest = await request('/api/escrow/config');
    if (latest.configured && !latest.enabled) throw new Error(latest.reason || 'The registered escrow contract could not be verified.'); if (latest.enabled) { setConfig(latest); setModal('create'); return; }
    const deployment = await monadWallet.deployEscrow(latest.resultSigner || latest.resultSignerAddress);
    const configured = await request('/api/escrow/config', { contractAddress: deployment.address, transactionHash: deployment.transactionHash });
    setConfig(configured); setModal('create'); notify('Escrow deployed and verified on Monad testnet.');
  });
  const fundRoom = () => invoke('Approve your test MON deposit in your wallet…', async () => {
    const account = await monadWallet.connectMonadWallet();
    if (account.address.toLowerCase() !== walletAddress.toLowerCase()) throw new Error('Switch back to the wallet that joined this room.');
    const funding = state.funding;
    if (!funding?.contractAddress) throw new Error('The room escrow is not configured.');
    const roomId = funding.escrowRoomId || funding.roomId;
    if (seats.includes(0)) await monadWallet.createEscrowRoom(funding.contractAddress, roomId, state.stake.amount, funding.refundAfter);
    else await monadWallet.joinEscrowRoom(funding.contractAddress, roomId, state.stake.amount);
    await request(`/api/rooms/${state.code}/funding`, {});
    setWalletBalance((await monadWallet.connectMonadWallet()).balance); notify('Your test MON stake is confirmed on-chain.');
  });
  const refreshFunding = () => invoke('Checking on-chain deposits…', async () => { await request(`/api/rooms/${state.code}/funding`, {}); notify('Funding status refreshed.'); });
  const leaveRoom = () => invoke('Closing the room…', async () => {
    const funding = state?.funding;
    if (funding?.hostFunded && !funding.guestFunded && seats.includes(0)) {
      const account = await monadWallet.connectMonadWallet();
      if (account.address.toLowerCase() !== walletAddress.toLowerCase()) throw new Error('Switch to the room host wallet to refund this stake.');
      await monadWallet.cancelEscrowRoom(funding.contractAddress, funding.escrowRoomId || funding.roomId);
      await monadWallet.withdrawEscrowCredit(funding.contractAddress);
      await request(`/api/rooms/${state.code}/funding`, {});
    }
    const left = await duel.leave();
    if (!left) throw new Error('The room server did not confirm your leave. Please try again.');
    setModal(null); lastRoom.current = null;
  });
  const practice = () => { window.open(`/?practice=1&roundSeconds=${practiceRoundSeconds}`, '_blank', 'noopener,noreferrer'); };
  const copy = async text => {
    if (await copyInviteText(text)) notify('Copied to clipboard.');
    else setError(text);
  };
  const handleTabKey = event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const next = event.key === 'Home' ? 'open' : event.key === 'End' ? 'mine' : tab === 'open' ? 'mine' : 'open'; setTab(next); document.getElementById(`${next}-tab`)?.focus(); };
  const ownRoom = state ? { id: state.id, code: state.code, host: state.players[0].name, mode: state.mode, phase: state.phase, players: state.players.filter(p => p.connected).length, stake: state.stake, funding: state.funding, current: true, live: true, address: state.players[0].name, asset: state.stake?.asset || 'MON', amount: state.stake?.amount || 0, duration: formatRound(state.roundSeconds), avatarSeed: state.funding?.hostAddress || walletAddress || state.players[0].name } : null;
  const publicRows = rooms.map(room => ({ ...room, live: true, address: room.host, asset: room.stake?.asset || 'MON', amount: room.stake?.amount || 0, duration: formatRound(room.roundSeconds), avatarSeed: room.funding?.hostAddress || room.host }));
  const previewRows = INITIAL_DUELS.map(profile => ({ ...profile, preview: true, avatarSeed: profile.address }));
  const listing = tab === 'mine' ? ownRoom ? [ownRoom] : [] : [...publicRows, ...previewRows];
  const funding = state?.funding;
  const myFunded = seats.includes(0) ? funding?.hostFunded : funding?.guestFunded;
  const bothFunded = funding?.hostFunded && funding?.guestFunded;
  const canEnter = state && (!funding || bothFunded || ['finished', 'void'].includes(state.phase));

  return <>
    <div className="terminal-background" aria-hidden="true"><FaultyTerminal tint="#7c3aed" glyphs="blocks" scale={2.9} digitSize={1.2} timeScale={0.5} brightness={0.6} glow={0} persistence={0} mouseStrength={0.5} mouseGlow={0} curvature={0} vignette={0} clickEffect="none" dpr={1} /></div>
    <div className="page-gradient" />
    <header className="site-header"><a className="brand" href="/"><BrandMark /><span>PERPDUEL</span></a><nav aria-label="Main navigation"><button className="text-button how-it-works" onClick={() => openModal('rules')}>How it works <Icon name="external" size={13} /></button><button className={`wallet-button ${walletAddress ? 'connected' : ''}`} onClick={() => openModal(walletAddress ? 'account' : 'wallet')}>{walletAddress && <span className="connection-dot" />}{walletAddress ? shortAddress(walletAddress) : 'Connect wallet'}</button></nav></header>
    <main>
      {settledId && <div className="content-width lobby-settlement"><button className="join-room-button" onClick={openSettlement}>Settle your last testnet duel <Icon name="arrow" size={15} /></button></div>}
      {modal === 'settlement' && <Modal title="Testnet duel settlement" onClose={closeModal}>
        {busy && <p role="status">Loading match result…</p>}
        {error && <p className="info-note" role="alert">{error}</p>}
        {settledDuel && <EscrowClaim
          code={settledDuel.code}
          contractAddress={settledDuel.funding.contractAddress}
          roomId={settledDuel.funding.escrowRoomId || settledDuel.funding.roomId}
          voided={settledDuel.phase === 'void' || settledDuel.winner === null}
          buttonClassName="black-button"
        />}
      </Modal>}
      <section className="hero" aria-labelledby="deposit-title"><h1 id="deposit-title">Deposit</h1><form className={`deposit-form ${error && !modal ? 'has-error' : ''}`} onSubmit={beginCreate}>
        <input ref={amountRef} aria-label="Deposit amount" aria-describedby="deposit-help" inputMode="decimal" placeholder="Enter stake" value={amount} onChange={e => { if (/^\d*\.?\d{0,6}$/.test(e.target.value)) { setAmount(e.target.value); setError(''); } }} />
        <output className="deposit-usd" aria-label="Estimated dollar reference" title="Mainnet token reference price only. Testnet MON has no monetary value.">{usdValue}</output><AssetSelect asset={asset} onChange={setAsset} /><button className="deposit-submit" type="submit" aria-label="Create a staked room"><Icon name="arrow" size={27} /></button>
      </form><p className={`deposit-help ${error && !modal ? 'error' : ''}`} id="deposit-help" role="status">{error && !modal ? error : <>Monad testnet<span className="help-dot">·</span>Your stake stays in escrow until the result.</>}</p></section>
      <section className="lobby content-width" aria-labelledby="duels-title"><div className="lobby-toolbar"><div className="tabs" role="tablist" aria-label="Duel lists"><button id="open-tab" role="tab" aria-selected={tab === 'open'} aria-controls="duel-panel" tabIndex={tab === 'open' ? 0 : -1} onKeyDown={handleTabKey} className={tab === 'open' ? 'active' : ''} onClick={() => setTab('open')}>Open duels <span>{rooms.length + INITIAL_DUELS.length}</span></button><button id="mine-tab" role="tab" aria-selected={tab === 'mine'} aria-controls="duel-panel" tabIndex={tab === 'mine' ? 0 : -1} onKeyDown={handleTabKey} className={tab === 'mine' ? 'active' : ''} onClick={() => setTab('mine')}>My duels {ownRoom && <span>1</span>}</button></div><div className="lobby-actions"><button className="join-room-button" onClick={openRoomJoin}><Icon name="plus" size={15} />Join room</button><button className="create-button" onClick={beginCreate}><Icon name="plus" size={17} />Create duel</button></div></div>
        <div className="duel-panel" id="duel-panel" role="tabpanel" aria-labelledby={`${tab}-tab`}><div className="table-toolbar"><h2 id="duels-title"><span className={`live-dot ${connected ? '' : 'offline'}`} />{tab === 'open' ? 'Find your next opponent' : 'Your rooms'}</h2><span className="network-caption">MONAD TESTNET <span>·</span> LIVE ROOMS + TRADER PREVIEWS</span></div><div className="duel-head"><span>Trader</span><span>Entry stake</span><span>Status</span><span>Duration</span><span className="right-align">Prize pool</span><span /></div>
        <div className="duel-rows">{listing.map(room => <div className={`duel-row ${room.preview ? 'preview-row' : ''}`} key={room.id}><div className="trader"><Avatar seed={room.avatarSeed} /><div><span className="trader-address">{room.address || room.host}</span><span className="trader-meta">{room.preview ? <>{room.wins}% win rate <span className="preview-tag">PREVIEW</span></> : room.current ? 'Your room' : `Room ${room.code}`}</span></div></div><div className="stake-cell"><Token asset={room.asset || 'MON'} size={23} /><span>{formatAmount(room.amount)} <span className="currency-label">{room.preview ? room.asset : 'test MON'}</span></span></div><div className="duel-status-cell"><span className={`duel-status-badge${!room.preview && !room.current ? ' is-open' : ''}`}>{duelStatus(room)}</span></div><div className="duration-cell"><Icon name="time" size={14} /><span>{room.duration}</span></div><div className="prize-cell">{formatAmount(round(room.amount * 2))}<span>{room.asset || 'MON'}</span></div><button className="join-button" onClick={() => room.live ? chooseRoom(room) : chooseProfile(room)}>{room.current && state?.code === room.code ? 'Open room' : room.preview ? 'Preview duel' : 'Join duel'}</button></div>)}</div>
        {!listing.length && <div className="empty-state room-empty"><BrandMark size={35} /><h3>{roomsError || (tab === 'mine' ? 'Your next duel starts here.' : 'The arena is open.')}</h3><p>{tab === 'mine' ? 'Create a room or join a friend using their room code.' : 'No public rooms yet. Create one, or join a friend by code.'}</p><div className="empty-actions"><button className="black-button" onClick={() => openModal('join')}>Join a room<Icon name="arrow" size={16} /></button><button className="practice-link" onClick={practice}>Try a practice bot</button></div></div>}
        <div className="table-footer"><span>Two traders. Equal stakes. One winner.</span><span><span className="mini-dot" />Test MON · no cash value</span></div></div>
      </section>
    </main>
    <footer className="site-footer content-width"><a className="footer-brand" href="/"><BrandMark size={20} />PERPDUEL</a><span>Trading, head to head.</span><div><button onClick={() => openModal('setup')}>Testnet setup</button><button onClick={() => openModal('rules')}>How it works <Icon name="external" size={12} /></button></div></footer>

    {modal === 'wallet' && <Modal title="Connect your wallet" onClose={closeModal}><div className="modal-brand"><BrandMark size={43} /></div><p className="modal-copy">Connect an EVM wallet on Monad testnet. A message signature links your wallet to your room; deposits require a separate transaction.</p><button className="wallet-option" disabled={!!busy} onClick={connectWallet}><span className="wallet-option-icon"><Icon name="wallet" size={23} /></span><span><strong>Browser wallet</strong><small>MetaMask, Rabby, or compatible wallet</small></span><Icon name="arrow" size={19} /></button>{error && <p className="form-error" role="alert">{error}</p>}{busy && <p className="transaction-status" role="status">{busy}</p>}<p className="modal-footnote">Monad testnet · Chain 10143 · Test MON has no cash value.</p></Modal>}

    {modal === 'account' && <Modal title="Your wallet" onClose={closeModal}><div className="account-id"><span className="connection-dot" />{shortAddress(walletAddress)}<span className="demo-label">Monad testnet</span></div><dl className="summary"><div><dt>Network</dt><dd>Monad testnet · 10143</dd></div><div><dt>Wallet balance</dt><dd>{walletBalance !== null ? `${Number(walletBalance).toFixed(4)} test MON` : 'Connect to refresh'}</dd></div></dl><p className="modal-copy">Deposits are made directly into a room’s escrow contract. PERPDUEL does not keep a spendable website balance.</p><button className="black-button full-width" disabled={!!busy} onClick={connectWallet}>Refresh wallet<Icon name="arrow" size={17} /></button>{error && <p className="form-error" role="alert">{error}</p>}</Modal>}

    {modal === 'create' && <Modal title="Create your duel" onClose={closeModal}><p className="modal-copy">Set your stake and share the room. The game starts after both deposits are confirmed and both players are ready.</p><form onSubmit={createRoom}><label className="field-label" htmlFor="player-name">Your name</label><input className="room-input" id="player-name" value={name} onChange={e => setName(e.target.value)} maxLength={24} placeholder="How should your rival know you?" /><dl className="summary create-summary"><div><dt>Your stake</dt><dd>{formatAmount(numericAmount)} test MON</dd></div><div><dt>Prize pool</dt><dd>{formatAmount(round(numericAmount * 2))} test MON</dd></div><div className="round-length-row"><dt>Round length</dt><dd><RoundDurationPicker value={roundSeconds} onChange={setRoundSeconds} /></dd></div><div><dt>Paper balance</dt><dd>$1,000 each</dd></div></dl><span className="field-label">Room visibility</span><div className="side-options visibility-options"><button type="button" className={visibility === 'public' ? 'chosen' : ''} aria-pressed={visibility === 'public'} onClick={() => setVisibility('public')}>Public lobby</button><button type="button" className={visibility === 'private' ? 'chosen' : ''} aria-pressed={visibility === 'private'} onClick={() => setVisibility('private')}>Invite only</button></div>{error && <p className="form-error" role="alert">{error}</p>}<button className="black-button full-width" disabled={!connected || !!busy} type="submit">{busy || 'Create room'}<Icon name="arrow" size={17} /></button><p className="modal-footnote">You approve the test MON deposit after the room is created.</p></form></Modal>}

    {modal === 'matchup' && <Modal title="Join duel" onClose={closeModal} className="matchup-dialog" cover={<MatchupCover />}><p className="modal-copy matchup-copy">{selectedRoom ? 'Review the open room, then join with the same test MON stake.' : 'Enter the room ID your opponent shared, or jump into a practice round.'}</p><div className="room-meta-line"><span className="room-network"><span className="live-dot" />{selectedRoom ? 'OPEN ROOM' : 'ROOM INVITE'}</span><span>{selectedRoom?.stake ? `${selectedRoom.duration} · ${formatAmount(selectedRoom.stake.amount)} test MON each` : 'Monad testnet · Chain 10143'}</span></div><form onSubmit={joinRoom}><div className="matchmaking-layout matchup-preview">
      <div className="matchmaking-player host-card"><span className="seat-eyebrow">PLAYER 1</span><Avatar seed={walletAddress || name || 'guest-player'} /><strong>You</strong><span className="waiting-name">{walletAddress ? 'Wallet connected' : 'Connect wallet to join'}</span></div>
      <div className="room-code-center"><span className="versus-pill">VS</span><div className="room-code-field"><label htmlFor="room-code">ROOM ID</label><input className="room-code-input" id="room-code" aria-label="Room ID" value={roomCode} onChange={e => { setRoomCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6)); setError(''); }} placeholder="A1B2C3" autoComplete="off" maxLength={6} required /><small>{selectedRoom ? 'LIVE ROOM' : '6-CHARACTER CODE'}</small></div></div>
      <div className={`matchmaking-player opponent-card ${selectedRoom ? 'known-opponent' : ''}`}><span className="seat-eyebrow">PLAYER 2</span>{selectedRoom ? <Avatar seed={selectedRoom.avatarSeed || selectedRoom.host} /> : <span className="waiting-avatar">?</span>}<strong>{selectedRoom?.host || 'LOADING'}</strong><span className="waiting-name">{selectedRoom ? 'Room creator' : selectedProfile ? 'Waiting for room ID' : 'Waiting for your opponent'}</span><span className="funding-badge">{selectedRoom ? 'Open · awaiting you' : 'Opponent loads after join'}</span></div>
    </div>{selectedProfile && <p className="preview-disclosure">{selectedProfile.address} · {selectedProfile.wins}% win rate is a trader profile preview. Paste a real room ID to enter a live duel.</p>}{error && <p className="form-error" role="alert">{error}</p>}
    <div className="matchup-actions">
      <div className="matchup-practice-options">
        <RoundDurationPicker value={practiceRoundSeconds} onChange={setPracticeRoundSeconds} label="Practice round length" />
        <button type="button" className="matchup-practice-button" onClick={() => { setModal(null); practice(); }}>Play bot</button>
      </div>
      <button className="matchup-join-button" disabled={!connected || !!busy} type="submit">{busy || (selectedRoom?.funding && !walletAddress ? 'Connect wallet to join' : 'Join duel')}</button>
    </div>
    <p className="modal-footnote">A live duel requires a room code and matching test MON deposit. Testnet MON has no cash value.</p></form></Modal>}

    {modal === 'setup' && <Modal title="Monad testnet escrow" onClose={closeModal}><p className="modal-copy">{config?.enabled ? 'The room escrow contract is ready.' : config?.configured ? (config.reason || 'The registered escrow contract could not be verified.') : 'Deploy the room escrow once from your wallet. Both players then deposit directly into this contract.'}</p><dl className="summary"><div><dt>Network</dt><dd>Monad testnet · 10143</dd></div><div><dt>Contract</dt><dd>{config?.contractAddress ? shortAddress(config.contractAddress) : 'Not deployed yet'}</dd></div><div><dt>Settlement</dt><dd>Server-signed match result</dd></div></dl><p className="info-note">Only test MON is used. The contract holds equal stakes, credits the winner, refunds a draw, and provides an expiry refund if the match server becomes unavailable.</p>{error && <p className="form-error" role="alert">{error}</p>}<button className="black-button full-width" disabled={!!busy || !config || config.configured && !config.enabled} onClick={config?.enabled ? closeModal : setupEscrow}>{busy || (config?.enabled ? 'Done' : config?.configured ? 'Escrow unavailable' : 'Deploy with my wallet')}<Icon name="arrow" size={17} /></button><p className="modal-footnote">Deployment spends testnet gas. Your wallet will show the transaction before you approve it.</p></Modal>}

    {modal === 'waiting' && state && <Modal title="Your duel room" onClose={closeModal} className="waiting-modal"><div className="room-meta-line"><span className="room-network"><span className="live-dot" />{state.mode === 'local' ? 'PRACTICE' : funding ? 'MONAD TESTNET' : 'PAPER DUEL'}</span><span>{formatRound(state.roundSeconds)} · {state.stake ? `${formatAmount(state.stake.amount * 2)} MON pool` : 'No stake'}</span></div><div className="matchmaking-layout">
      {[0, 1].map(seat => <div className={`matchmaking-player ${seat === 1 ? 'opponent-card' : 'host-card'}`} key={seat}><span className="seat-eyebrow">PLAYER {seat + 1}</span>{state.players[seat].connected ? <Avatar seed={seat === 0 ? funding?.hostAddress || walletAddress || state.players[seat].name : funding?.guestAddress || state.players[seat].name} /> : <span className="waiting-avatar">?</span>}<strong>{seats.includes(seat) ? 'You' : state.players[seat].connected ? state.players[seat].name : 'Finding your rival'}</strong><span className="waiting-name">{seats.includes(seat) ? state.players[seat].name : state.players[seat].connected ? 'Connected' : 'Share your room ID to invite'}</span><span className={`funding-badge ${(seat === 0 ? funding?.hostFunded : funding?.guestFunded) ? 'funded' : ''}`}>{(seat === 0 ? funding?.hostFunded : funding?.guestFunded) ? '✓ Stake confirmed' : state.players[seat].connected ? (funding ? 'Awaiting deposit' : 'Connected') : 'Waiting for player'}</span></div>)}
      <div className="room-code-center"><span>VS</span><button className="room-code-copy" onClick={() => copy(state.code)} aria-label={`Copy room code ${state.code}`}>{state.code}<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V4H4v12h4" /></svg></button><small>ROOM ID</small></div>
    </div><div className="waiting-actions"><button className="join-room-button" onClick={async () => copy(await roomInvite(state.code, Boolean(funding)))}>Copy invite link<Icon name="external" size={13} /></button><button className="practice-link" onClick={practice}>Play a practice bot<Icon name="arrow" size={14} /></button></div><div className="room-status-note" role="status">{!funding ? 'Enter the arena and ready up.' : bothFunded ? 'Both stakes confirmed. Enter the arena and ready up.' : myFunded ? 'Your stake is secured. Waiting for the other player’s deposit.' : 'Approve your room stake to secure your seat.'}</div>{error && <p className="form-error" role="alert">{error}</p>}
    <div className="room-primary-actions">{!myFunded && state.stake && !['void', 'finished'].includes(state.phase) && <button className="black-button" disabled={!!busy || (!seats.includes(0) && !funding?.hostFunded)} onClick={fundRoom}>{busy || `Deposit ${formatAmount(state.stake.amount)} test MON`}<Icon name="wallet" size={16} /></button>}{canEnter && <a className="black-button" href={`/arena?room=${state.code}`}>Enter arena<Icon name="arrow" size={17} /></a>}{myFunded && !bothFunded && <button className="refresh-funding" disabled={!!busy} onClick={refreshFunding}>Check deposits</button>}</div><button className="cancel-room-button" disabled={!!busy || !!bothFunded} onClick={leaveRoom}>{funding?.hostFunded && seats.includes(0) ? 'Cancel room & refund stake' : 'Leave room'}</button><p className="modal-footnote">Test MON has no cash value. Practice bots never play for staked funds.</p></Modal>}

    {modal === 'rules' && <Modal title="Trading, head to head." onClose={closeModal}><ol className="rules-list"><li><span>01</span><div><h3>Create or join a room</h3><p>Use a public room or share the six-character room ID with a friend.</p></div></li><li><span>02</span><div><h3>Lock equal stakes</h3><p>Each player deposits the same test MON amount into the Monad testnet escrow. Both players ready up.</p></div></li><li><span>03</span><div><h3>Trade for one to five minutes</h3><p>Each starts with $1,000 paper funds. Trade six live crypto markets at 3× leverage using your keyboard, controller, or on-screen controls.</p></div></li><li><span>04</span><div><h3>Claim the pool</h3><p>The server settles the trading result. The winner submits a signed result to claim the pool; draws and void rounds refund both stakes.</p></div></li></ol><p className="info-note">The trading score is equity minus $1,000 minus 35% of maximum drawdown. Market data comes from Hyperliquid. The escrow trusts this server’s signed result; this is a testnet build.</p><button className="black-button full-width" onClick={closeModal}>Got it<Icon name="check" size={17} /></button></Modal>}
    {toast && <div className="toast" role="status"><span className="toast-check"><Icon name="check" size={15} /></span>{toast}<button aria-label="Dismiss notification" onClick={() => setToast('')}><Icon name="close" size={15} /></button></div>}
  </>;
}
