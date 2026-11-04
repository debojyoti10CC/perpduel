import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { Activity, ArrowDownLeft, ArrowRight, ArrowUpRight, Check, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, Copy, Download, Expand, ExternalLink, Gamepad2, History, Info, Keyboard, Link2, LoaderCircle, LockKeyhole, Maximize2, Minus, Plus, Radio, RotateCcw, Settings2, ShieldCheck, Signal, Search, LayoutGrid, List, Swords, Trophy, Users, Volume2, VolumeX, WifiOff, X, Zap } from 'lucide-react';
import { COINS, DEFAULT_ROUND_SECONDS, type InputAction, type Market, type LedgerInfo, type MatchState, type Player, type TradeAction } from '../../shared/types';
import RoundDurationPicker from '../components/RoundDurationPicker.jsx';
import { useDuel, apiOrigin, type Feedback } from './hooks/useDuel';
import { useControllers } from './hooks/useControllers';
import { isNavigationAction, navigateMarket, type ArenaInput, type FeedbackKind, type MenuAction } from './input';
import MarketChart from './components/MarketChart';
import MarketPositionMarkers, { marketPositionLabel, type PositionsByMarket } from './components/MarketPositionMarkers';
import PlayerCard from './components/PlayerCard';
import ControllerArt from './components/ControllerArt';
import Modal from './components/Modal';
import ReceiptViewer from './components/ReceiptViewer';
import CoinIcon from './components/CoinIcon';
import MarketSearch from './components/MarketSearch';
import MarketTable from './components/MarketTable';
import NetworkStatus from './components/NetworkStatus';
import EscrowClaim from './components/EscrowClaim';
import './styles.css';
import './design-system.css';
import './arena-layout.css';
import './dark-arena.css';
import { compact, downloadJSON, emptyAccount, money, names, price, shortHash, signed, useStorageValue } from './lib';

type Toast = { id: string; message: string; kind: string; seat?: number };
type Dialog = 'rules' | 'controllers' | 'settings' | 'history' | 'result' | 'ledger' | 'network' | 'setup' | 'positions' | 'leave' | null;
const controls = [ ['A', 'Long / increase long', 'W', 'I'], ['X', 'Short / increase short', 'S', 'K'], ['B', 'Close half', 'A', 'J'], ['Y', 'Close all', 'D', 'L'], ['← ↑ ↓ →', 'Move across markets', 'Q/E · R/F', 'Arrow keys'], ['R STICK', 'Scroll page / panels', 'Scroll', 'Scroll'], ['LB / RB', 'Adjust order margin', 'Z / C', 'U / O'], ['START', 'Ready up', 'Space', 'Enter'] ];
const statusNames: Record<MatchState['phase'], string> = { lobby: 'Waiting for ready', registering: 'Registering the duel', countdown: 'Get ready', active: 'Duel in progress', settling: 'Settling positions', finished: 'Duel complete', void: 'Duel voided' };
const placeholderPlayer = (seat: number): Player => ({ ...emptyAccount(), name: seat === 0 ? 'You' : 'Your opponent', connected: false, ready: false, selected: seat === 0 ? 0 : 1, margin: 100 });

function formatClock(seconds: number) {
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function Logo() { return <div className="brand arena-brand"><svg width="29" height="29" viewBox="0 0 36 36" fill="none" aria-hidden="true"><circle cx="18" cy="18" r="13.8" stroke="currentColor" strokeWidth="1.5"/><path d="m18 1.9 16.1 16.1L18 34.1 1.9 18Z" stroke="currentColor" strokeWidth="1.5"/><path d="m18 9.3 8.7 8.7-8.7 8.7L9.3 18Z" fill="currentColor"/></svg><span>PERPDUEL</span></div>; }

export default function App() {
  const [dialog, setDialog] = useState<Dialog>(null);
  const [ledgerInfo, setLedgerInfo] = useState<LedgerInfo | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [heroSearchVisible, setHeroSearchVisible] = useState(false);
  const [marketView, setMarketView] = useState<'list' | 'charts'>('charts');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [flashes, setFlashes] = useState<Record<number, string>>({});
  const [intensity, setIntensity] = useState(() => useStorageValue('duel-haptics', 0.65));
  const [sound, setSound] = useState(() => useStorageValue('duel-sound', false));
  const [minutes, setMinutes] = useState(1);
  const [focusedCoin, setFocusedCoin] = useState<typeof COINS[number]>('BTC');
  const [mode, setMode] = useState<'local' | 'online'>('online');
  const [roundSeconds, setRoundSeconds] = useState<number>(DEFAULT_ROUND_SECONDS);
  const [joinMode, setJoinMode] = useState(Boolean(new URLSearchParams(location.search).get('room')));
  const [name, setName] = useState('');
  const [name2, setName2] = useState('');
  const [roomCode, setRoomCode] = useState(new URLSearchParams(location.search).get('room') ?? '');
  const [joining, setJoining] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [activeSeat, setActiveSeat] = useState(0);
  const [, refreshSelection] = useState(0);
  const pendingSelection = useRef(new Map<number, {
    id: string; match: string; selected: number; at: number; acknowledged: boolean;
  }>());
  const [tapeTab, setTapeTab] = useState('positions');
  const [history, setHistory] = useState<Record<string, unknown>[]>([]);
  const [historyStatus, setHistoryStatus] = useState('');
  const [copied, setCopied] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const hapticRef = useRef<(seat: number, kind: FeedbackKind) => void>(() => undefined);
  const toastTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const notify = useCallback((message: string, kind = 'info', seat?: number) => {
    if (/Not enough available margin/i.test(message)) message = 'Insufficient paper funds. Lower margin or close a position.';
    const id = crypto.randomUUID(); setToasts(items => kind === 'reject' && items.some(item => item.kind === kind && item.seat === seat && item.message === message) ? items : [...items.slice(-3), { id, message, kind, seat }]);
    toastTimers.current.push(setTimeout(() => setToasts(items => items.filter(item => item.id !== id)), 4200));
  }, []);
  useEffect(() => () => toastTimers.current.forEach(clearTimeout), []);
  const feedback = useCallback((event: Feedback) => {
    const pending = pendingSelection.current.get(event.seat);
    if (pending && pending.id === event.id) {
      if (event.kind === 'select') pending.acknowledged = true;
      if (event.kind === 'reject') {
        pendingSelection.current.delete(event.seat);
        refreshSelection(version => version + 1);
      }
    }
    hapticRef.current(event.seat, event.kind);
    if (event.kind !== 'select') notify(event.message, event.kind, event.seat);
    setFlashes(current => ({ ...current, [event.seat]: event.kind }));
    toastTimers.current.push(setTimeout(() => setFlashes(current => ({ ...current, [event.seat]: '' })), 500));
  }, [notify]);
  const error = useCallback((message: string) => { setJoining(false); notify(message, 'reject'); }, [notify]);
  const duel = useDuel(feedback, error);
  const { state, markets, seats, send, connected } = duel;
  const practiceMode = new URLSearchParams(location.search).get('bot') === '1';
  const inputSeats = practiceMode ? seats.filter(seat => seat === 0) : seats;
  useEffect(() => {
    if (!connected || state || !roomCode) return;
    let hasSession = false;
    try { const saved = JSON.parse(sessionStorage.getItem(`trading-duel-session:${apiOrigin || location.origin}`) ?? 'null'); hasSession = Boolean(saved?.code && saved?.token); } catch { /* unavailable storage */ }
    if (!hasSession) setDialog('setup');
  }, [connected, Boolean(state), roomCode]);
  const stateRef = useRef(state); stateRef.current = state;
  const marketsRef = useRef(markets); marketsRef.current = markets;
  const offsetRef = useRef(duel.offset); offsetRef.current = duel.offset;

  useEffect(() => {
    if (!practiceMode || state?.mode !== 'local' || state.phase !== 'lobby' || !seats.includes(1) || state.players[1].ready) return;
    send({ type: 'action', id: crypto.randomUUID(), seat: 1, action: 'ready' });
  }, [practiceMode, state?.id, state?.phase, state?.players[1].ready, seats.join(','), send]);
  useEffect(() => {
    if (!practiceMode || state?.mode !== 'local' || state.phase !== 'active' || !seats.includes(1)) return;
    let turn = 0;
    const play = () => {
      const current = stateRef.current;
      if (!current || current.phase !== 'active' || current.players[1].disabled) return;
      const bot = current.players[1];
      const marketIndex = turn++ % COINS.length;
      const currentMarkets = marketsRef.current;
      const quote = currentMarkets.find(item => item.coin === COINS[marketIndex]);
      const serverTime = Date.now() + offsetRef.current;
      if (!quote?.available || quote.time > serverTime || serverTime - quote.time > 5000) return;
      const sendBot = (action: InputAction, market?: number) => send({ type: 'action', id: crypto.randomUUID(), seat: 1, action, market });
      sendBot('select', marketIndex);
      const position = bot.positions.find(item => item.coin === quote.coin);
      if (position && turn % 3 === 0) { sendBot('close'); return; }
      if (position || bot.availableMargin < 101) return;
      // The bot sees only the same received live marks shown to the player.
      const samples = quote.priceHistory?.filter(point => point.time <= serverTime / 1000 && point.time >= serverTime / 1000 - 25) ?? [];
      if (samples.length < 2) return;
      const direction = samples.at(-1)!.value >= samples[0].value ? 'long' : 'short';
      sendBot(direction);
    };
    const first = setTimeout(play, 4000);
    const timer = setInterval(play, 9000);
    return () => { clearTimeout(first); clearInterval(timer); };
  }, [practiceMode, state?.id, state?.mode, state?.phase, seats.join(','), send]);

  useEffect(() => {
    for (const [seat, pending] of pendingSelection.current) {
      if (!connected || state?.id !== pending.match ||
          (pending.acknowledged && state.players[seat].selected === pending.selected)) {
        pendingSelection.current.delete(seat);
      }
    }
  }, [connected, state]);
  const action = useCallback((seat: number, input: ArenaInput, market?: number) => {
    const current = stateRef.current;
    if (!current) { if (input === 'ready' || input === 'long') setDialog('setup'); return; }
    const pending = pendingSelection.current.get(seat);
    const awaitingSelection = pending?.match === current.id;
    if (input === 'select' || isNavigationAction(input)) {
      const origin = awaitingSelection ? pending.selected : current.players[seat].selected;
      let selected = market;
      if (input !== 'select') {
        const grid = document.querySelector('.market-grid');
        const columns = grid ? getComputedStyle(grid).gridTemplateColumns.split(/\s+/).filter(Boolean).length : 1;
        selected = navigateMarket(origin, input, COINS.length, columns);
      }
      if (selected === undefined) return;
      const id = crypto.randomUUID();
      if (send({ type: 'action', id, seat, action: 'select', market: selected })) {
        pendingSelection.current.set(seat, { id, match: current.id, selected, at: Date.now(), acknowledged: false });
        refreshSelection(version => version + 1);
        setActiveSeat(seat);
      }
      return;
    }
    if (awaitingSelection && ['long', 'short', 'half', 'close'].includes(input)) {
      if (!pending.acknowledged || current.players[seat].selected !== pending.selected) {
        const message = Date.now() - pending.at < 2000
          ? 'Confirming market selection. Try again in a moment.'
          : 'Market selection was not confirmed. Select a market again before trading.';
        notify(message, 'reject', seat);
        return;
      }
    }
    send({ type: 'action', id: crypto.randomUUID(), seat, action: input, market });
  }, [notify, send]);
  const scrollWithController = useCallback((pixels: number) => {
    const panel = Array.from(document.querySelectorAll('.modal')).at(-1);
    if (panel) panel.scrollBy({top:pixels,behavior:'auto'});
  }, []);
  const menuAction = useCallback((input: MenuAction) => {
    const panel = Array.from(document.querySelectorAll<HTMLElement>('.modal[role="dialog"]')).at(-1);
    if (!panel) return;
    const durationTrigger = panel.querySelector<HTMLButtonElement>('.arena-round-duration button[aria-expanded="true"]');
    if (input === 'back') {
      if (durationTrigger) { durationTrigger.click(); return; }
      setSearchOpen(false); setExpanded(null); setDialog(null); return;
    }
    const durationMenu = durationTrigger && panel.querySelector('.arena-round-duration [role="listbox"]');
    const items = Array.from((durationMenu || panel).querySelectorAll<HTMLElement>('button:not(:disabled),a[href],select:not(:disabled)')).filter(item => item.getBoundingClientRect().width > 0 && item.getBoundingClientRect().height > 0);
    if (!items.length) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    if (input === 'confirm') { if (current >= 0) items[current].click(); return; }
    const direction = input === 'previous' || input === 'up' ? -1 : 1;
    const next = items[(Math.max(0,current) + direction + items.length) % items.length];
    panel.querySelectorAll('.controller-menu-focus').forEach(item => item.classList.remove('controller-menu-focus'));
    next.classList.add('controller-menu-focus'); next.focus({preventScroll:true});
    const bounds = panel.getBoundingClientRect(), target = next.getBoundingClientRect();
    if (target.bottom > bounds.bottom - 16) panel.scrollBy({top:target.bottom - bounds.bottom + 24});
    else if (target.top < bounds.top + 16) panel.scrollBy({top:target.top - bounds.top - 24});
  }, []);
  const controllers = useControllers({ enabled: !dialog && !expanded && !searchOpen, menuOpen: Boolean(dialog || expanded || searchOpen), onMenuAction: menuAction, seats: state ? inputSeats : practiceMode ? [0] : [0, 1], onAction: action, onScroll: scrollWithController, intensity, sound });
  useEffect(() => {
    if (dialog !== 'setup') return;
    const button = document.querySelector<HTMLButtonElement>('.setup-panel button[type="submit"]');
    button?.focus({preventScroll:true}); button?.classList.add('controller-menu-focus');
  }, [dialog]);
  hapticRef.current = controllers.vibrate;
  useEffect(() => {
    let alive = true;
    const readNetwork = async () => {
      try { const response = await fetch(`${apiOrigin}/api/health`); if (!response.ok) throw new Error('offline'); const data = await response.json(); if (alive) setLedgerInfo(data.ledger ?? null); }
      catch { if (alive) setLedgerInfo(null); }
    };
    void readNetwork(); const timer = setInterval(readNetwork, 15000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  useEffect(() => { localStorage.setItem('duel-haptics', JSON.stringify(intensity)); }, [intensity]);
  useEffect(() => { localStorage.setItem('duel-sound', JSON.stringify(sound)); }, [sound]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 100); return () => clearInterval(timer); }, []);
  useEffect(() => { if (state) { setJoining(false); setDialog(current => current === 'setup' ? null : current); } }, [state]);
  useEffect(() => { setMarketView('charts'); }, [state?.id]);
  useEffect(() => {
    if (state || typeof IntersectionObserver === 'undefined') return;
    const hero = document.querySelector('.hero-search-trigger');
    if (!hero) return;
    const observer = new IntersectionObserver(([entry]) => setHeroSearchVisible(entry.isIntersecting), { rootMargin: '-80px 0px 0px 0px' });
    observer.observe(hero);
    return () => observer.disconnect();
  }, [Boolean(state)]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const editable = event.target instanceof Element && Boolean(event.target.closest('input, textarea, select, [contenteditable="true"]'));
      if (((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') || (event.key === '/' && !editable && !event.ctrlKey && !event.metaKey && !event.altKey)) {
        event.preventDefault(); setDialog(null); setExpanded(null); setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  useEffect(() => { if (seats.length === 1) setActiveSeat(seats[0]); }, [seats]);
  const lastPhase = useRef('');
  useEffect(() => {
    if (state?.phase !== lastPhase.current && (state?.phase === 'finished' || state?.phase === 'void')) {
      setSearchOpen(false); setExpanded(null);
      setDialog('result'); inputSeats.forEach(seat => controllers.vibrate(seat, 'result'));
    }
    lastPhase.current = state?.phase ?? '';
  }, [state?.phase, seats, controllers.vibrate]);
  const serverNow = now + duel.offset;
  const stakeState = state;
  const funding = stakeState?.funding;
  const roomStake = stakeState?.stake;
  const stakeAmount = (value: number) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 }).format(value);
  const waitingForRival = state?.phase === 'lobby' && !state.players.every(player => player.connected);
  const scheduledSeconds = state && state.endAt > state.startAt
    ? Math.ceil((state.endAt - state.startAt) / 1000)
    : DEFAULT_ROUND_SECONDS;
  const matchRoundSeconds = state?.roundSeconds ?? scheduledSeconds;
  const matchRoundLabel = matchRoundSeconds % 60 === 0 ? `${matchRoundSeconds / 60} MIN` : `${matchRoundSeconds} SEC`;
  let seconds = matchRoundSeconds;
  if (state?.phase === 'active') seconds = Math.max(0, Math.ceil((state.endAt - serverNow) / 1000));
  else if (state?.phase === 'countdown') seconds = Math.max(0, Math.ceil((state.startAt - serverNow) / 1000));
  else if (state && ['settling', 'finished', 'void'].includes(state.phase)) seconds = 0;
  const milestone = useRef('');
  useEffect(() => { const key = `${state?.id}:${state?.phase}:${seconds}`; if (key !== milestone.current && (state?.phase === 'countdown' || (state?.phase === 'active' && [60, 30, 10, 5, 4, 3, 2, 1].includes(seconds)))) { inputSeats.forEach(seat => controllers.vibrate(seat, 'countdown')); milestone.current = key; } }, [seconds, state?.phase, state?.id, seats, controllers.vibrate]);
  const healthyMarkets = markets.filter(m => m.available && m.time > serverNow - 5000);
  const feedHealthy = connected && duel.feedConnected && healthyMarkets.length === 6;
  const players = state?.players.map((player, seat) => {
    const pending = pendingSelection.current.get(seat);
    return connected && pending?.match === state.id && now - pending.at < 2000
      ? { ...player, selected: pending.selected }
      : player;
  }) ?? [placeholderPlayer(0), placeholderPlayer(1)];
  const selectedMarket = markets.find(m => m.coin === expanded);
  const isActive = state?.phase === 'active';
  const allPositions = players.flatMap((p, seat) => p.positions.map(position => ({ ...position, seat })));
  const positionsByMarket: PositionsByMarket = {};
  if (isActive || state?.phase === 'settling') {
    for (const position of allPositions) {
      if (position.quantity !== 0 && inputSeats.includes(position.seat)) {
        (positionsByMarket[position.coin] ??= []).push(position);
      }
    }
  }
  const selectMarket = (coin: typeof COINS[number]) => {
    if (state && inputSeats.includes(activeSeat)) action(activeSeat, 'select', COINS.indexOf(coin));
    setSearchOpen(false); setExpanded(coin);
  };
  const openMarketSearch = () => { setDialog(null); setExpanded(null); setSearchOpen(true); };
  const create = (event: FormEvent) => {
    event.preventDefault(); if (!connected) return;
    setJoining(true);
    const ok = joinMode
      ? send({ type: 'join', code: roomCode.trim().toUpperCase(), name: name.trim() || 'Challenger' })
      : send({ type: 'create', mode, name: name.trim() || 'Player One', name2: name2.trim() || 'Player Two', roundSeconds });
    if (!ok) setJoining(false);
  };
  const copyInvite = async () => {
    if (!state) return;
    try { await navigator.clipboard.writeText(`${location.origin}/?room=${state.code}`); setCopied(true); toastTimers.current.push(setTimeout(() => setCopied(false), 1800)); }
    catch { notify(`Room code: ${state.code}. Open this server on the other laptop and enter that code.`); }
  };
  const openHistory = async () => {
    setDialog('history'); setHistoryStatus('Loading…');
    try { const response = await fetch(`${apiOrigin}/api/history`); if (!response.ok) throw new Error('Match history unavailable'); const data = await response.json(); setHistory(Array.isArray(data) ? data : data.matches ?? []); setHistoryStatus(''); }
    catch { setHistoryStatus('History unavailable. Check the server connection.'); }
  };
  const leaveToLobby = async () => {
    setLeaving(true);
    const left = await duel.leave();
    if (left) location.assign('/');
    else { setLeaving(false); notify('The room did not confirm your departure. Reconnect and try again.', 'reject'); }
  };
  const fullscreen = async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); } catch { notify('Fullscreen unavailable. Open in a browser.'); } };

  return <div className={`app-shell compact-arena dark-arena${state ? ' in-match' : ''}${isActive && seconds <= 30 ? ' final-minute' : ''}`}>
    <header className={`topbar${heroSearchVisible ? '' : ' has-scrolled'}`}>
      <a href="/" className="brand-link" aria-label="PERPDUEL lobby" onClick={event => { if (state && !['finished', 'void'].includes(state.phase)) { event.preventDefault(); setDialog('leave'); } }}><Logo/></a>
      <button className="header-search-trigger" onClick={openMarketSearch} aria-label="Find markets"><Search size={17}/><span>Find markets...</span><kbd>⌘ K</kbd></button>
      <div className="header-right">
        <nav aria-label="Main navigation"><a className="nav-item arena-lobby-link" href="/" onClick={event => { if (state && !['finished','void'].includes(state.phase)) { event.preventDefault(); setDialog('leave'); } }}><ChevronLeft size={15}/> Lobby</a><button className="nav-item" onClick={openHistory}><History size={15}/> History</button><button className="nav-item" onClick={() => setDialog('rules')}><CircleHelp size={15}/> Rules</button><button className="nav-item active" onClick={() => { setDialog(null); setExpanded(null); if (!state) setDialog('setup'); }}><Swords size={15}/> Arena</button></nav>
        <div className="topbar-tools"><span className={`connection-indicator ${feedHealthy ? 'online' : ''}`}><i/>{duel.source === 'test-fixture' ? 'TEST FIXTURE' : feedHealthy ? 'Live prices' : connected ? 'Feed offline' : 'Connecting'}</span><button className="icon-button" aria-label="Controller settings" onClick={() => setDialog('controllers')}><Gamepad2 size={19}/><span className="count-bubble">{controllers.controllers.length}</span></button><button className="icon-button" aria-label="Settings" onClick={() => setDialog('settings')}><Settings2 size={18}/></button><button className="icon-button fullscreen-button" aria-label="Toggle fullscreen" onClick={fullscreen}><Expand size={17}/></button></div>
      </div>
    </header>
    <main>
      {!state ? <section className="arena-welcome"><div><h1>New duel</h1><p>1–5 min · $1,000 paper funds each · 3×</p></div><div className="arena-start-actions"><button className="button" onClick={()=>setDialog('controllers')}><Gamepad2 size={16}/> Controllers</button><button className="button button-primary" onClick={()=>setDialog('setup')}>Create / join duel <ArrowRight size={16}/></button></div></section> : <>
        <div className="match-topline"><span><Radio size={12}/> {practiceMode ? 'PRACTICE ARENA' : state.mode === 'local' ? 'SAME SCREEN' : 'ONLINE ARENA'}<span className="room-code">ROOM {state.code}</span>{state.mode === 'online' && <button className="text-button" onClick={copyInvite}>{copied ? <Check size={12}/> : <Copy size={12}/>} {copied ? 'Link copied' : 'Invite rival'}</button>}</span><button className="text-button" onClick={() => setDialog('ledger')}><ShieldCheck size={13}/>{state.ledger.mode === 'monad' ? 'Monad' : 'Local EVM'} ledger<ChevronRight size={13}/></button></div>
        <section className="scoreboard">
          <PlayerCard player={players[0]} seat={0} owns={inputSeats.includes(0)} controller={controllers.controllers.some(c => c.seat === 0)} flash={flashes[0]} phase={state.phase} avatarSeed={funding?.hostAddress || players[0].name}/>
          <div className={`clock-card${isActive && seconds <= 30 ? ' urgent' : ''}`}>
            <div className="clock-top">
              <span className={isActive ? 'live-clock-label' : ''}>{isActive ? <><i/> DUEL LIVE</> : state.phase === 'countdown' ? 'STARTING IN' : 'ROUND TIMER'}</span>
              <span className="clock-duration">{matchRoundLabel}</span>
            </div>
            <div className="clock-number">{state.phase === 'countdown' ? <span className="countdown-number">{seconds || 'GO'}</span> : formatClock(seconds)}</div>
            <div className="clock-track"><i style={{ width: `${isActive ? seconds / Math.max(1, matchRoundSeconds) * 100 : state.phase === 'lobby' ? 100 : 0}%` }}/></div>
            <span className="clock-phase">{waitingForRival ? 'Waiting for rival' : statusNames[state.phase]}</span>
          </div>
          <PlayerCard player={players[1]} seat={1} owns={inputSeats.includes(1)} controller={controllers.controllers.some(c => c.seat === 1)} flash={flashes[1]} phase={state.phase} avatarSeed={funding?.guestAddress || players[1].name}/>
        </section>
        {state.phase === 'lobby' && <div className="lobby-banner"><div><span className="step-circle">1</span><strong>{players.every(p => p.connected) ? 'Ready' : 'Waiting for opponent'}</strong><span>{players.every(p => p.connected) ? 'Both players must ready up.' : 'Share the room code.'}</span></div><button className="text-button" onClick={() => setDialog('controllers')}><Gamepad2 size={14}/> Controller check<ArrowRight size={13}/></button></div>}
        {['registering', 'settling'].includes(state.phase) && <div className="status-banner"><LoaderCircle size={16} className="spin"/>{state.phase === 'registering' ? 'Setting up accounts.' : 'Closing positions and settling scores.'}</div>}
        {state.players.some(p => p.disconnectedAt) && ['active','countdown'].includes(state.phase) && <div className="status-banner danger"><WifiOff size={16}/> Player disconnected. Clock and prices continue; reconnect within 20 seconds or the duel is void.</div>}
      </>}

      <section className="markets-section" aria-label="Six live perpetual markets"><div className="section-heading"><div className="section-title"><Activity size={16}/><h2>Markets</h2><span className="muted-count">06</span><span className="exchange-label">HYPERLIQUID PERPETUALS</span></div><div className="chart-toolbar"><div className="market-view-toggle" role="group" aria-label="Market view"><button className={marketView==='list'?'selected':''} onClick={()=>setMarketView('list')} aria-label="Market list" aria-pressed={marketView==='list'}><List size={15}/><span>List</span></button><button className={marketView==='charts'?'selected':''} onClick={()=>setMarketView('charts')} aria-label="Market charts" aria-pressed={marketView==='charts'}><LayoutGrid size={15}/><span>Charts</span></button></div>{state && <div className="click-seat" aria-label="Mouse controls for player">Mouse:<button onClick={() => setActiveSeat(0)} className={activeSeat === 0 ? 'p1 selected' : 'p1'} disabled={!inputSeats.includes(0)}>P1</button><button onClick={() => setActiveSeat(1)} className={activeSeat === 1 ? 'p2 selected' : 'p2'} disabled={!inputSeats.includes(1)}>P2</button></div>}{marketView==='charts' && <div className="timeframes" role="group" aria-label="Time window">{[1,5,15].map(m => <button key={m} className={minutes === m ? 'selected' : ''} onClick={() => setMinutes(m)}>{m}m</button>)}</div>}{marketView==='charts' && <span className="chart-grid-label">3 × 2</span>}</div></div>
      <div className="arena-mobile-market-picker" aria-label="Choose visible market">
        {COINS.map((coin, index) => {
          const selected = (state ? COINS[players[activeSeat].selected] : focusedCoin) === coin;
          const positions = (positionsByMarket[coin] ?? []).filter(position => position.seat === activeSeat);
          return (
            <button
              key={coin}
              className={selected ? 'selected' : ''}
              aria-pressed={selected}
              aria-label={marketPositionLabel(coin, positions)}
              onClick={() => {
                setFocusedCoin(coin);
                if (state && inputSeats.includes(activeSeat)) action(activeSeat, 'select', index);
              }}
            >
              {coin}
              <MarketPositionMarkers positions={positions} />
            </button>
          );
        })}
      </div>
      {!feedHealthy && <div className="feed-warning"><Signal size={14}/>{duel.source === 'test-fixture' ? 'TEST DATA — These fixture prices are for automated verification only.' : !connected ? 'Connecting to the match server. Trading is unavailable until the connection is restored.' : 'Waiting for fresh exchange quotes. Orders stay blocked while data is missing or more than 5 seconds old.'}</div>}
      {duel.source === 'test-fixture' && <div className="fixture-ribbon">AUTOMATED TEST FIXTURE · NOT LIVE MARKET DATA</div>}
      {marketView==='list' ? <MarketTable markets={markets} players={state ? players : undefined} positionsByMarket={positionsByMarket} onSelect={selectMarket} now={serverNow}/> : <div className="market-grid">{COINS.map(coin => { const market = markets.find(m => m.coin === coin); const fresh = Boolean(market?.available && market.time > serverNow - 5000); const positions = positionsByMarket[coin] ?? []; const selections = state ? players.map((p, i) => p.selected === COINS.indexOf(coin) ? i : -1).filter(i => i !== -1) : []; return <article key={coin} data-market={coin} className={`market-card${(state ? COINS[players[activeSeat].selected] : focusedCoin)===coin?' mobile-focus':''}${selections.includes(0) ? ' selected-p1' : ''}${selections.includes(1) ? ' selected-p2' : ''}`}><div className="market-card-header"><button className="coin-title" onClick={() => state && inputSeats.includes(activeSeat) ? action(activeSeat, 'select', COINS.indexOf(coin)) : setExpanded(coin)} aria-label={marketPositionLabel(`Select ${coin} for player ${activeSeat + 1}`, positions)}><CoinIcon coin={coin}/><div><div className="market-symbol-line"><strong>{coin}<span>/ USD</span><span className="perp-badge">PERP</span></strong><MarketPositionMarkers positions={positions} /></div><small>{names[coin]}</small></div></button><div className="market-card-right"><span className={`market-change${(market?.change24h ?? 0) < 0 ? ' negative' : ' positive'}`}>{market?.available ? `${market.change24h >= 0 ? '+' : ''}${market.change24h.toFixed(2)}%` : '—'}</span><button className="icon-button expand-chart-button" aria-label={`Expand ${coin} chart and order book`} onClick={() => setExpanded(coin)}><Maximize2 size={13}/></button></div></div><div className="market-price-row"><strong className={fresh ? '' : 'unavailable-price'}>{price(market?.mark ?? 0)}</strong><div className="market-ownership">{selections.map(seat=><span key={seat} className={`market-selection-badge p${seat+1}`} title={`${players[seat].name}'s selected market`}>P{seat+1} SELECTED</span>)}<span className={`quote-status${fresh ? ' fresh' : ''}`}><i/>{fresh ? 'LIVE' : market?.mark ? 'STALE' : 'CONNECTING'}</span></div></div>{market && market.mark > 0 ? <MarketChart market={market} minutes={minutes} now={serverNow}/> : <div className="chart-empty"><span className="empty-chart-line"/><Activity size={22}/><span>Waiting for prices</span></div>}<div className="market-card-footer"><span>VOL <b>{market?.volume24h ? `$${compact(market.volume24h)}` : '—'}</b></span><span>Last {minutes}m</span></div></article>; })}</div>}</section>

      {state && <><section className="trading-docks" aria-label="Player trade controls">{players.map((player, seat) => { const own = inputSeats.includes(seat), coin = COINS[player.selected], quote = markets.find(m => m.coin === coin), fresh = Boolean(quote?.available && quote.time > serverNow - 5000), canTrade = own && connected && isActive && !player.disabled && fresh; const position = player.positions.find(p => p.coin === coin); return <div className={`trade-dock player-${seat}${seat===activeSeat?' active-dock':''}`} key={seat}><div className="dock-top"><span className={`seat-marker p${seat+1}`}>P{seat+1}</span><div className="dock-symbol"><button disabled={!own} aria-label={`Player ${seat+1} previous market`} onClick={() => action(seat,'previous')}><ChevronLeft size={15}/></button><strong>{coin}<span>-PERP</span></strong><button disabled={!own} aria-label={`Player ${seat+1} next market`} onClick={() => action(seat,'next')}><ChevronRight size={15}/></button></div><div className="margin-control"><span>PAPER MARGIN</span><button disabled={!own || player.margin <= 100} onClick={() => action(seat,'marginDown')} aria-label={`Decrease player ${seat+1} order margin`}><Minus size={13}/></button><strong>{money(player.margin,0)}</strong><button disabled={!own || player.margin >= 500} onClick={() => action(seat,'marginUp')} aria-label={`Increase player ${seat+1} order margin`}><Plus size={13}/></button><span className="leverage-badge">3×</span></div></div><div className="trade-buttons"><button className="trade-button long" disabled={!canTrade} onClick={() => action(seat,'long')}><span className="pad-key a">A</span>Long <ArrowUpRight size={15}/></button><button className="trade-button short" disabled={!canTrade} onClick={() => action(seat,'short')}><span className="pad-key x">X</span>Short <ArrowDownLeft size={15}/></button><button className="trade-button close-half" disabled={!canTrade || !position} onClick={() => action(seat,'half')}><span className="pad-key b">B</span>Close ½</button><button className="trade-button close-all" disabled={!canTrade || !position} onClick={() => action(seat,'close')}><span className="pad-key y">Y</span>Close all</button></div><div className="dock-bottom"><span>{player.disabled ? 'Risk floor reached. Account locked this round.' : !own ? 'Controlled by your opponent' : isActive ? fresh ? `Paper available ${money(player.availableMargin)} · virtual exposure ${money(player.margin*3,0)}` : 'Stale quote — trading blocked' : ['finished','void'].includes(state.phase) ? 'View results to start a rematch.' : 'Press START or ready up to begin'}</span>{state.phase === 'lobby' && <button className={`ready-button${player.ready ? ' is-ready' : ''}`} disabled={!own || !player.connected} onClick={() => action(seat,'ready')}>{player.ready ? <><Check size={13}/> Ready</> : <>Ready up <ArrowRight size={13}/></>}</button>}</div></div>; })}</section>
      </>}
      <footer className="arena-utility-bar"><div>{state ? <><button onClick={()=>{setTapeTab('positions');setDialog('positions');}}>Positions <b>{allPositions.length}</b></button><button onClick={()=>{setTapeTab('fills');setDialog('positions');}}>Trades <b>{state.fills.length}</b></button><button onClick={()=>setDialog('result')} disabled={!['finished','void'].includes(state.phase)}>Results</button></> : null}</div><span className="arena-control-hint">L stick / D-pad: move · A: long · X: short · B/Y: close · Start: ready</span><a href="https://github.com/benjitaylor/liveline" target="_blank" rel="noreferrer">Liveline</a></footer>
    </main>

    {dialog === 'leave' && <Modal title="Return to the lobby?" onClose={() => setDialog(null)}><p className="arena-leave-copy">{state?.phase === 'lobby' ? 'This closes your current room. A funded testnet room can be resolved for a refund.' : 'Leaving ends this round for both players. A funded testnet room can be resolved for a refund after it is voided.'}</p><div className="modal-actions"><button className="button" onClick={() => setDialog(null)}>Stay in arena</button><button className="button button-primary" disabled={leaving} onClick={leaveToLobby}>{leaving ? <><LoaderCircle size={15} className="spin"/> Leaving…</> : <>Leave room <ArrowRight size={15}/></>}</button></div></Modal>}
    {dialog === 'setup' && !state && <Modal title={joinMode ? 'Join duel' : 'Setup'} onClose={() => setDialog(null)}>
      <div className="setup-panel">
        <form className="join-form" onSubmit={create}>
          <div className="mode-switch" role="group" aria-label="Match mode">
            <button type="button" className={!joinMode && mode === 'local' ? 'selected' : ''} onClick={() => { setMode('local'); setJoinMode(false); }}><Users size={15}/> Same screen</button>
            <button type="button" className={joinMode || mode === 'online' ? 'selected' : ''} onClick={() => setMode('online')}><Link2 size={15}/> Two laptops</button>
          </div>
          <div className="name-fields">
            <label>Your name<input value={name} onChange={e => setName(e.target.value)} placeholder="Player One" maxLength={20} autoComplete="nickname"/></label>
            {!joinMode && mode === 'local' && <label>Opponent’s name<input value={name2} onChange={e => setName2(e.target.value)} placeholder="Player Two" maxLength={20}/></label>}
            {joinMode && <label>Room code<input aria-label="Room code" className="room-code-input" value={roomCode} onChange={e => setRoomCode(e.target.value.toUpperCase())} placeholder="ABC123" maxLength={8} required/></label>}
          </div>
          {!joinMode && <div className="arena-round-length">
            <span>Round length</span>
            <RoundDurationPicker className="arena-round-duration" value={roundSeconds} onChange={setRoundSeconds}/>
          </div>}
          <button className="button button-primary join-button" disabled={!connected || joining} type="submit">
            {joining ? <><LoaderCircle size={17} className="spin"/> Connecting…</> : <>{joinMode ? 'Join duel' : 'Create duel'}<ArrowRight size={17}/></>}
          </button>
          <div className="join-footer">
            <span>{joinMode ? 'Enter the room code.' : mode === 'local' ? 'Two controllers or shared keyboard.' : 'Share the room code.'}</span>
            <button type="button" onClick={() => { setJoinMode(!joinMode); setMode('online'); }}>{joinMode ? 'Create room' : 'Join room'}</button>
          </div>
        </form>
      </div>
    </Modal>}
    {dialog === 'positions' && state && <Modal title="Positions and trades" onClose={()=>setDialog(null)} wide><section className="positions-panel"><div className="positions-header"><div className="panel-tabs"><button className={tapeTab === 'positions' ? 'selected' : ''} onClick={() => setTapeTab('positions')}>Open positions<span>{allPositions.length}</span></button><button className={tapeTab === 'fills' ? 'selected' : ''} onClick={() => setTapeTab('fills')}>Trade tape<span>{state.fills.length}</span></button></div><span><span className="blue-dot"/> CONFIRMED LEDGER STATE</span></div>{tapeTab === 'positions' ? allPositions.length ? <div className="table-scroll"><table><thead><tr><th>PLAYER / MARKET</th><th>SIDE</th><th>SIZE</th><th>ENTRY</th><th>PAPER MARGIN</th><th>PAPER P&L</th></tr></thead><tbody>{allPositions.map(pos => <tr key={`${pos.seat}-${pos.coin}`}><td><span className={`seat-marker small p${pos.seat+1}`}>P{pos.seat+1}</span><strong>{pos.coin}-PERP</strong></td><td><span className={pos.quantity>0?'positive':'negative'}>{pos.quantity>0?'LONG':'SHORT'}</span><span className="table-leverage">3×</span></td><td>{Math.abs(pos.quantity).toFixed(5)} {pos.coin}</td><td>{price(pos.entry)}</td><td>{money(pos.margin)}</td><td className={pos.unrealizedPnl>=0?'positive':'negative'}>{signed(pos.unrealizedPnl)}</td></tr>)}</tbody></table></div> : <div className="empty-positions"><Activity size={22}/><div><strong>No open positions</strong></div></div> : state.fills.length ? <div className="table-scroll"><table><thead><tr><th>TIME</th><th>PLAYER / MARKET</th><th>ACTION</th><th>EXECUTION</th><th>FEE</th><th>TRANSACTION</th></tr></thead><tbody>{state.fills.slice(0,50).map(fill => <tr key={fill.id}><td>{new Date(fill.time).toLocaleTimeString()}</td><td><span className={`seat-marker small p${fill.seat+1}`}>P{fill.seat+1}</span>{fill.coin}</td><td className={fill.action==='long'?'positive':fill.action==='short'?'negative':''}>{fill.action.toUpperCase()}</td><td>{price(fill.price)}</td><td>{money(fill.fee,4)}</td><td><button className="hash-button" onClick={() => { navigator.clipboard.writeText(fill.txHash).then(()=>notify('Transaction hash copied.')).catch(()=>notify(fill.txHash)); }}>{shortHash(fill.txHash)} <Copy size={11}/></button></td></tr>)}</tbody></table></div> : <div className="empty-positions"><History size={22}/><div><strong>No trades</strong></div></div>}</section></Modal>}
    <NetworkStatus stakeContract={funding?.contractAddress} open={dialog==='network'} ledger={state?.ledger??ledgerInfo} onClose={()=>setDialog(null)}/>
    <MarketSearch open={searchOpen} markets={markets} onClose={()=>setSearchOpen(false)} onSelect={selectMarket}/>
    {(dialog === 'rules') && <Modal title="Rules" onClose={() => setDialog(null)} wide><div className="rules-summary"><div><strong>$1,000</strong><span>Starting paper funds</span></div><div><strong>3×</strong><span>Fixed leverage</span></div><div><strong>{state ? formatClock(matchRoundSeconds) : '1–5 min'}</strong><span>Round length</span></div></div><div className="rules-columns"><div><h3>Scoring</h3><div className="score-formula">Final equity − $1,000<br/><span>− 0.35 × maximum drawdown</span></div><p>Higher score wins. Lower drawdown breaks a tie; otherwise, draw.</p><h3>Execution</h3><ul className="rules-list"><li>Each player has one paper account across all six markets.</li><li>Order margin: $100, $250, or $500, subject to available funds and fees.</li><li>Buying executes at the ask plus 1 basis point. Selling executes at the bid minus 1 basis point.</li><li>Fees are 0.05% of executed notional per fill. Funding is zero.</li><li>Changing sides closes the old position before opening the new one.</li><li>At $200 equity or less, the account automatically closes and is disabled.</li><li>At the deadline, both accounts close against the same fresh snapshot. An extended outage voids the duel.</li></ul></div><div><h3>Controls</h3><div className="control-table"><div className="control-table-head"><span>ACTION</span><span>GAMEPAD</span><span>P1 KEYS</span><span>P2 KEYS</span></div>{controls.map(([pad,label,k1,k2])=><div key={pad}><span>{label}</span><kbd>{pad}</kbd><kbd>{k1}</kbd><kbd>{k2}</kbd></div>)}</div><p className="fine-print">Remote players can use P1 keys. Move diagonally with the left stick or two adjacent D-pad directions. Recenter or release between moves. Held trade buttons do not repeat.</p><div className="rules-note"><Info size={17}/><span>Trades use paper funds. A funded room's test MON stake settles separately. The operator supplies market prices.</span></div></div></div><div className="modal-actions"><button className="button" onClick={() => setDialog('controllers')}><Gamepad2 size={16}/> Controllers</button><button className="button button-primary" onClick={() => setDialog(null)}>Done <ArrowRight size={16}/></button></div></Modal>}
    {dialog === 'controllers' && <Modal title="Controllers" subtitle="Connect a controller and press a button." onClose={() => setDialog(null)} wide><div className="controller-grid">{[0,1].map(seat => { const pad = controllers.controllers.find(c=>c.seat===seat) ?? (!state ? controllers.controllers[seat] : undefined); return <div className={`controller-slot player-${seat}`} key={seat}><div className="controller-slot-heading"><span className={`seat-marker p${seat+1}`}>P{seat+1}</span><strong>{players[seat].name}</strong><span className={`status-tag${pad ? ' ready':''}`}>{pad ? 'CONNECTED':'KEYBOARD READY'}</span></div><ControllerArt active={pad?.buttons} axis={pad?.axis} verticalAxis={pad?.verticalAxis} rightAxis={pad?.rightAxis}/><h3>{pad ? pad.id.split('(')[0].trim() : 'Not connected'}</h3><p>{pad ? pad.mapping === 'standard' ? 'Standard mapping' : 'Unsupported mapping. Use a standard controller or keyboard.' : 'USB or Bluetooth.'}</p><div className="controller-slot-bottom"><Keyboard size={14}/><span>{seat===0?'Q E / R F · W S A D · Z C · Space':'← ↑ ↓ → · I K J L · U O · Enter'}</span>{pad && <button className="text-button" onClick={()=>controllers.vibrate(seat,'fill')}>Test vibration <Activity size={12}/></button>}</div></div>; })}</div>{controllers.controllers.length>0 && state && <div className="assignment-list">{controllers.controllers.map(pad=><label key={pad.index}><Gamepad2 size={15}/><span>{pad.id}</span><select aria-label={`Assign controller ${pad.index+1}`} value={pad.seat??''} onChange={e=>controllers.assign(pad.index,e.target.value===''?null:Number(e.target.value))}><option value="">Unassigned</option>{seats.map(s=><option key={s} value={s}>Player {s+1}</option>)}</select></label>)}</div>}<div className="rules-note"><Info size={17}/><span>{controllers.supported ? 'Keep this page focused. Vibration depends on your controller and browser.' : 'Gamepad unavailable. Use Chrome or Edge on localhost or HTTPS, or use the keyboard.'}</span></div>{controllers.lastInput && <p className="last-input">LAST INPUT <b>P{controllers.lastInput.seat+1} / {controllers.lastInput.action.toUpperCase()}</b></p>}<div className="modal-actions"><button className="text-button" onClick={()=>setDialog('rules')}>Controls <ChevronRight size={14}/></button><button className="button button-primary" onClick={()=>setDialog(null)}>Done <ArrowRight size={16}/></button></div></Modal>}
    {dialog === 'settings' && <Modal title="Settings" onClose={()=>setDialog(null)}><div className="setting-row"><div><h3>Controller vibration</h3><p>Fills, rejections, risk and countdown cues.</p></div><span className="setting-value">{Math.round(intensity*100)}%</span></div><input className="range-input" type="range" min="0" max="1" step="0.05" aria-label="Vibration intensity" value={intensity} onChange={e=>setIntensity(Number(e.target.value))}/><div className="range-labels"><span>Off</span><span>Full intensity</span></div><div className="setting-row setting-divider"><div><h3>Sound feedback</h3><p>Action and timer cues.</p></div><button className={`toggle${sound?' on':''}`} role="switch" aria-checked={sound} aria-label="Sound feedback" onClick={()=>setSound(!sound)}><span/></button></div><div className="setting-row setting-divider"><div><h3>Display</h3></div><button className="button button-small" onClick={fullscreen}><Expand size={14}/> Fullscreen</button></div>{state && <div className="setting-row setting-divider"><div><h3>Leave this room</h3>{isActive&&<p>Leaving voids this duel for both players.</p>}</div><button className="button button-small danger-button" onClick={()=>setDialog('leave')}>Leave room</button></div>}</Modal>}
    {dialog === 'ledger' && state && <Modal title="Ledger" onClose={()=>setDialog(null)}><div className="ledger-network"><ShieldCheck size={24}/><div><h3>{state.ledger.mode==='monad'?'Monad':'Local EVM'} paper ledger</h3><p>Chain ID {state.ledger.chainId} · {state.ledger.mode==='local-evm'?'Local contract':'Operator connected'}</p></div><span className="status-tag ready">CONNECTED</span></div><dl className="ledger-details"><dt>Contract</dt><dd>{state.ledger.contractAddress}</dd><dt>Relayer</dt><dd>{state.ledger.relayerAddress}</dd><dt>Match ID</dt><dd>{state.id}</dd><dt>Latest transaction</dt><dd>{state.txHash??'No transaction yet'}</dd></dl><ReceiptViewer hash={state.txHash}/><p className="fine-print">The operator supplies Hyperliquid quotes; the contract applies paper trading rules.{state.ledger.mode==='local-evm'?' Local receipts reset when the server stops.':''}</p><button className="button" onClick={()=>downloadJSON(state,`trading-duel-${state.code}.json`)}><Download size={15}/> Export</button></Modal>}
    {dialog === 'history' && (
      <Modal
        title="History"
        headingIcon={<span className="result-heading-icon" aria-hidden="true"><History size={19} /></span>}
        className="arena-history-dialog"
        onClose={() => setDialog(null)}
      >
        {historyStatus ? (
          <div className="empty-history" role="status">{historyStatus}</div>
        ) : !history.length ? (
          <div className="empty-history">
            <History size={24} aria-hidden="true" />
            <h3>No saved duels</h3>
          </div>
        ) : (
          <ul className="history-list" aria-label="Saved duels">
            {history.map((record, index) => {
              const match = (record.state ?? record) as unknown as MatchState;
              const [first, second] = match.players ?? [];
              const voided = match.phase === 'void';
              const winner = match.winner === 0 ? first : match.winner === 1 ? second : undefined;
              const result = voided ? 'Voided' : winner ? `${winner.name} won` : match.winner === null ? 'Draw' : 'Saved';
              return (
                <li className="history-item" key={match.id ?? index}>
                  <span className="history-icon" aria-hidden="true">
                    {voided ? <WifiOff size={17} /> : <Swords size={17} />}
                  </span>
                  <div className="history-match">
                    <h3>{first?.name || 'Player One'} <span>vs</span> {second?.name || 'Player Two'}</h3>
                    <div className="history-meta">
                      {match.code && <span>Room {match.code}</span>}
                      <span className={`history-outcome${winner && !voided ? ' is-decided' : ''}`}>{result}</span>
                    </div>
                  </div>
                  <div className="history-scores">
                    {voided ? <span>Unscored</span> : <>
                      <b>{first?.score?.toFixed(2) ?? '—'}</b>
                      <span aria-hidden="true">/</span>
                      <b>{second?.score?.toFixed(2) ?? '—'}</b>
                    </>}
                  </div>
                  <button
                    className="icon-button history-export"
                    aria-label={match.code ? `Download match record for room ${match.code}` : 'Download match record'}
                    title="Download match record"
                    onClick={() => downloadJSON(record, `duel-${match.code ?? index}.json`)}
                  >
                    <Download size={16} aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Modal>
    )}
    {dialog === 'result' && state && (
      <Modal
        title={state.phase === 'void' ? 'Duel voided' : state.winner === null ? 'Duel drawn' : 'Duel results'}
        subtitle={state.phase === 'void' ? state.reason : undefined}
        headingIcon={<span className="result-heading-icon" aria-hidden="true">
          {state.phase === 'void' ? <WifiOff size={19} /> : <Trophy size={19} />}
        </span>}
        className="arena-result-dialog"
        onClose={() => setDialog(null)}
      >
        <div className="result-grid">
          {players.map((player, seat) => {
            const voided = state.phase === 'void';
            const won = !voided && state.winner === seat;
            return (
              <section className={`result-player${won ? ' winner' : ''}`} key={seat}>
                <div className="result-player-heading">
                  <span className={`seat-marker p${seat + 1}`}>P{seat + 1}</span>
                  <h3>{player.name}</h3>
                  {won && <span className="winner-badge"><Trophy size={11} /> Winner</span>}
                </div>
                <div className="result-metric">
                  <span>{voided ? 'Last confirmed equity' : 'Duel score'}</span>
                  <strong>{voided ? money(player.equity) : `${player.score >= 0 ? '+' : ''}${player.score.toFixed(2)}`}</strong>
                </div>
                <dl className="result-breakdown">
                  {!voided && <>
                    <div><dt>Final equity</dt><dd>{money(player.equity)}</dd></div>
                    <div><dt>Starting funds</dt><dd>− $1,000.00</dd></div>
                    <div><dt>Drawdown penalty × 0.35</dt><dd>− {money(player.maxDrawdown * .35)}</dd></div>
                  </>}
                  <div><dt>Maximum drawdown</dt><dd>{money(player.maxDrawdown)}</dd></div>
                  <div><dt>Paper fees</dt><dd>{money(player.fees, 4)}</dd></div>
                </dl>
              </section>
            );
          })}
        </div>
        {roomStake && (
          <div className="arena-result-stake">
            <span>{funding ? 'Test MON prize pool' : 'Demo prize pool'}</span>
            <strong>{stakeAmount(roomStake.amount * 2)} {roomStake.asset}</strong>
            <p>{funding
              ? state.phase === 'void' || state.winner === null
                ? 'Resolve the round and withdraw your test MON refund.'
                : `${players[state.winner].name} can resolve the round and withdraw the test MON pool.`
              : state.phase === 'void' || state.winner === null
                ? 'Reserved demo stakes are refunded.'
                : stakeState?.stakeStatus === 'paid'
                  ? `${players[state.winner].name} receives the demo pool.`
                  : 'No real funds were used.'}</p>
          </div>
        )}
        {funding && <EscrowClaim
          code={state.code}
          contractAddress={funding.contractAddress}
          roomId={funding.escrowRoomId || funding.roomId}
          voided={state.phase === 'void' || state.winner === null}
        />}
        {state.phase === 'finished' && <div className="result-note">
          <ShieldCheck size={14} /> Settled · {state.ledger.mode === 'local-evm' ? 'Local ledger' : 'Monad'}
        </div>}
        <div className="modal-actions">
          <button className="button" onClick={() => downloadJSON(state, `duel-${state.code}.json`)}>
            <Download size={15} /> Export
          </button>
          <button className="button button-primary" disabled={leaving} onClick={() => {
            if (funding) { void leaveToLobby(); return; }
            send({ type: 'rematch' });
            setDialog(null);
          }}>
            {leaving ? <LoaderCircle size={15} className="spin" /> : <RotateCcw size={15} />}
            {funding ? 'New funded duel' : 'Rematch'}
          </button>
        </div>
      </Modal>
    )}
    {expanded && <Modal title={`${expanded} / USD`} subtitle={`${names[expanded as keyof typeof names]} · Hyperliquid`} onClose={()=>setExpanded(null)} wide><>{selectedMarket && !selectedMarket.available && <div className="feed-warning"><Signal size={14}/> Stale price. Orders blocked.</div>}</><div className="expanded-price"><CoinIcon coin={expanded}/><strong>{price(selectedMarket?.mark??0)}</strong><span className={(selectedMarket?.change24h??0)>=0?'positive':'negative'}>{(selectedMarket?.change24h??0).toFixed(2)}% <small>24H</small></span><div className="timeframes" role="group" aria-label="Time window">{[1,5,15].map(m=><button key={m} className={minutes===m?'selected':''} onClick={()=>setMinutes(m)}>{m}m</button>)}</div></div>{selectedMarket && selectedMarket.mark>0?<MarketChart market={selectedMarket} minutes={minutes} now={serverNow} expanded/>:<div className="chart-empty">Prices unavailable</div>}<div className="depth-heading"><h3>Order book</h3><span>Spread {selectedMarket?price(selectedMarket.ask-selectedMarket.bid):'—'} · snapshot {selectedMarket?new Date(selectedMarket.time).toLocaleTimeString():'unavailable'}</span></div><div className="depth-grid">{(['bids','asks'] as const).map(side=><div key={side}><div className="depth-table-head"><span>{side==='bids'?'BID PRICE':'ASK PRICE'} (USD)</span><span>SIZE ({expanded})</span><span>TOTAL</span></div>{selectedMarket?.[side]?.length?selectedMarket[side].slice(0,8).map((level,index,all)=>{const total=all.slice(0,index+1).reduce((sum,l)=>sum+l.size,0),max=all.reduce((sum,l)=>sum+l.size,0);return <div className={`depth-row ${side}`} key={`${side}-${index}`} style={{'--depth':`${Math.min(100,total/max*100)}%`} as CSSProperties}><span>{price(level.price)}</span><span>{level.size.toFixed(4)}</span><span>{total.toFixed(4)}</span></div>;}):<p className="depth-unavailable">Order-book data unavailable.</p>}</div>)}</div></Modal>}
    <div className="toast-stack" aria-live="polite" aria-atomic="false">{toasts.map(toast=><div className={`toast toast-${toast.kind}`} key={toast.id}>{toast.kind==='reject'?<Info size={16}/>:toast.kind==='fill'?<Check size={16}/>:<Activity size={16}/>}<span>{toast.seat!==undefined&&<b className={`p${toast.seat+1}`}>P{toast.seat+1} </b>}{toast.message}</span><button aria-label="Dismiss notification" onClick={()=>setToasts(items=>items.filter(item=>item.id!==toast.id))}><X size={13}/></button></div>)}</div>
  </div>;
}
