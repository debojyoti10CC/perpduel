import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';
import { COINS, MARGINS, isRoundDuration, type Account, type ClientMessage, type InputAction, type LedgerInfo, type LedgerSnapshot, type MatchState, type Player, type Quote, type RoomSummary, type ServerMessage, type TradeAction } from '../shared/types.ts';
import type { MarketFeed } from './markets.ts';
import { DemoBank, validateStake } from './demoBank.ts';
import { EscrowService } from './escrow.ts';
import { roomKey } from '../shared/escrow.ts';
import { ZeroAddress, getAddress } from 'ethers';

export interface MatchLedger {
  info: LedgerInfo;
  create(id: string, startAt: number, endAt: number): Promise<LedgerSnapshot>;
  update(id: string, quotes: Quote[]): Promise<LedgerSnapshot>;
  trade(id: string, seat: number, market: number, action: TradeAction, margin: number, nonce: number, quotes: Quote[]): Promise<{ snapshot: LedgerSnapshot; txHash: string; fill?: { quantity: number; price: number; fee: number }; fills?: { action: TradeAction; quantity: number; price: number; fee: number }[] }>;
  settle(id: string, quotes: Quote[]): Promise<LedgerSnapshot>;
  void(id: string, reason?: string): Promise<void>;
  read(id: string): Promise<LedgerSnapshot>;
  close(): Promise<void>;
}
export interface MatchOptions { roundMs: number; countdownMs: number; recoveryMs: number; outageMs: number; dataDir: string }
export interface Peer { ws: WebSocket; room?: Room; seats: number[]; token?: string; accountId: string; queue: Promise<void>; windowStart: number; count: number }
interface Owner { token: string; seats: number[]; accountId: string; walletAddress?: string; peer?: Peer }
interface Room {
  state: MatchState;
  owners: Owner[];
  queue: Promise<void>;
  pendingTick: boolean;
  registered: boolean;
  seen: Set<string>;
  lastQuoteAt: number;
  lastSampleAt: number;
  lastTouchedAt: number;
  finalSnapshot?: Quote[];
  visibility: 'public' | 'private';
  createdAt: number;
}
const ACTIONS = new Set<InputAction>(['long', 'short', 'half', 'close', 'previous', 'next', 'marginDown', 'marginUp', 'ready', 'select']);
export const blankAccount = (): Account => ({ cash: 1000, equity: 1000, realizedPnl: 0, unrealizedPnl: 0, fees: 0, reservedMargin: 0, availableMargin: 1000, peakEquity: 1000, maxDrawdown: 0, score: 0, disabled: false, positions: [], nonce: 0 });
const player = (name: string, connected = false): Player => ({ ...blankAccount(), name, connected, ready: false, selected: 0, margin: 100 });
const cleanName = (input: unknown, fallback: string): string => typeof input === 'string' ? input.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24) || fallback : fallback;
const safeTokenEqual = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const terminal = (room: Room) => room.state.phase === 'finished' || room.state.phase === 'void';
export function send(peer: Peer, message: ServerMessage): void { if (peer.ws.readyState === WebSocket.OPEN) peer.ws.send(JSON.stringify(message)); }
function readableError(error: any): string {
  const text = error?.shortMessage || error?.reason || error?.message || 'The ledger could not confirm this action';
  // Avoid leaking internal RPC request bodies or operator details into feedback.
  return String(text).split('\n')[0].slice(0, 220);
}

export class MatchManager {
  readonly peers = new Set<Peer>();
  readonly rooms = new Map<string, Room>();
  private tickTimer?: ReturnType<typeof setInterval>;
  private broadcastTimer?: ReturnType<typeof setInterval>;
  private history: MatchState[] = [];
  readonly bank: DemoBank;
  readonly escrow: EscrowService;
  private controlQueue: Promise<void> = Promise.resolve();
  constructor(readonly ledger: MatchLedger, readonly feed: MarketFeed, readonly options: MatchOptions) { this.bank = new DemoBank(options.dataDir); this.escrow = new EscrowService(options.dataDir); }

  async start(): Promise<void> {
    await this.bank.start();
    await this.escrow.start();
    await mkdir(path.join(this.options.dataDir, 'active'), { recursive: true });
    await mkdir(path.join(this.options.dataDir, 'matches'), { recursive: true });
    // An interrupted process cannot reconstruct an in-memory chain or seat leases.
    // Preserve the last confirmed account record, explicitly void the interrupted duel.
    const activePath = path.join(this.options.dataDir, 'active');
    for (const name of await readdir(activePath)) {
      if (!/^[a-f0-9-]+\.json$/.test(name)) continue;
      try {
        const state = JSON.parse(await readFile(path.join(activePath, name), 'utf8')) as MatchState;
        state.phase = 'void'; state.winner = null; state.reason = 'The match server restarted. Interrupted rounds are void.';
        if (state.stake && !state.funding) state.stakeStatus = 'refunded';
        if (state.funding && state.funding.guestFunded) state.funding.status = 'claimable';
        await this.writeRecord(state, false);
        await rm(path.join(activePath, name), { force: true });
      } catch { /* A partial old file is not a playable round. */ }
    }
    const savedDirectory = path.join(this.options.dataDir, 'matches');
    const savedNames = (await readdir(savedDirectory)).filter(x => /^[a-f0-9-]+\.json$/.test(x));
    const newestFiles = (await Promise.all(savedNames.map(async name => ({ name, modified: (await stat(path.join(savedDirectory, name))).mtimeMs })))).sort((a, b) => b.modified - a.modified).slice(0, 200);
    for (const { name } of newestFiles) {
      try { this.history.push(JSON.parse(await readFile(path.join(this.options.dataDir, 'matches', name), 'utf8'))); } catch { /* Ignore corrupt records; never synthesize results. */ }
    }
    this.history.sort((a, b) => b.serverTime - a.serverTime);
    this.tickTimer = setInterval(() => this.tick(), 100);
    this.broadcastTimer = setInterval(() => {
      const now = Date.now();
      const markets: ServerMessage = { type: 'markets', markets: this.feed.snapshot(now), serverTime: now, source: this.feed.source, connected: this.feed.connected, clock: this.feed.clock };
      for (const peer of this.peers) send(peer, markets);
      for (const room of this.rooms.values()) this.broadcast(room);
    }, 500);
  }
  add(ws: WebSocket, accountId = this.bank.guest()): Peer {
    const peer: Peer = { ws, seats: [], accountId, queue: Promise.resolve(), windowStart: Date.now(), count: 0 };
    this.peers.add(peer);
    send(peer, { type: 'markets', markets: this.feed.snapshot(), serverTime: Date.now(), source: this.feed.source, connected: this.feed.connected, clock: this.feed.clock });
    return peer;
  }
  detach(peer: Peer): void {
    this.peers.delete(peer);
    const room = peer.room;
    if (!room) return;
    const owner = room.owners.find(x => x.peer === peer);
    if (!owner) return; // A newer resume already replaced this socket.
    owner.peer = undefined;
    const now = Date.now();
    for (const seat of owner.seats) { room.state.players[seat].connected = false; room.state.players[seat].disconnectedAt = now; room.state.players[seat].ready = false; }
    this.broadcast(room);
  }
  async handle(peer: Peer, raw: unknown): Promise<void> {
    const next = peer.queue.then(() => this.process(peer, raw));
    peer.queue = next.catch(() => {});
    return next;
  }
  private async process(peer: Peer, raw: unknown): Promise<void> {
    const now = Date.now();
    if (now - peer.windowStart > 1000) { peer.windowStart = now; peer.count = 0; }
    if (++peer.count > 20) { send(peer, { type: 'error', message: 'Too many inputs. Please slow down.' }); return; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid message');
    const message = raw as ClientMessage;
    if (message.type === 'ping') { if (typeof message.time === 'number' && Number.isFinite(message.time)) send(peer, { type: 'pong', time: message.time, serverTime: Date.now() }); return; }
    if (message.type === 'create') return this.control(() => this.create(peer, message));
    if (message.type === 'join') return this.control(() => this.join(peer, message));
    if (message.type === 'resume') return this.control(() => this.resume(peer, message));
    const room = peer.room;
    if (!room) throw new Error('Create or join a duel first');
    room.lastTouchedAt = now;
    if (message.type === 'leave') {
      await this.enqueue(room, async () => {
        if (!terminal(room)) await this.voidRoom(room, 'A player left the duel. Stakes were returned.');
        this.detach(peer); peer.room = undefined; peer.seats = []; peer.token = undefined;
        send(peer, { type: 'left' });
      });
      return;
    }
    if (message.type === 'rematch') {
      await this.enqueue(room, async () => {
        if (!terminal(room)) throw new Error('Finish the current duel before a rematch');
        const names = room.state.players.map(x => x.name);
        const stake = room.state.stake;
        // Each participant must explicitly fund a new wager. A rematch never
        // silently charges both wallets at the request of only one player.
        if (stake) throw new Error('Create a new room to confirm a new stake.');
        room.state = this.initialState(room.state.code, room.state.mode, names[0], names[1], room.state.roundSeconds);
        room.state.players.forEach((p, i) => { p.connected = room.owners.some(owner => owner.peer && owner.seats.includes(i)); });
        room.registered = false; room.seen.clear(); room.finalSnapshot = undefined; room.lastSampleAt = 0;
        this.broadcast(room);
      });
      return;
    }
    if (message.type !== 'action') throw new Error('Unknown message type');
    if (!Number.isInteger(message.seat) || !peer.seats.includes(message.seat)) throw new Error('That player seat belongs to another session');
    if (room.state.funding && room.owners.find(owner => owner.peer === peer)?.walletAddress !== this.bank.walletAddress(peer.accountId)) throw new Error('Sign in with the wallet that owns this player seat.');
    if (typeof message.id !== 'string' || !/^[A-Za-z0-9_.:-]{1,120}$/.test(message.id)) throw new Error('Every input needs a valid unique action id');
    if (!ACTIONS.has(message.action)) throw new Error('Unknown input action');
    const actionKey = `${peer.token}:${message.id}`;
    if (room.seen.has(actionKey)) return;
    if (room.seen.size > 10_000) throw new Error('Input limit reached for this round');
    room.seen.add(actionKey);
    await this.enqueue(room, async () => {
      try { await this.action(room, message.seat, message.action, message.market, message.id); }
      catch (error) { this.feedback(room, message.seat, 'reject', readableError(error), message.id); }
    });
  }
  private initialState(code: string, mode: 'local' | 'online', name: string, name2: string, roundSeconds = Math.ceil(this.options.roundMs / 1000)): MatchState {
    return { id: randomUUID(), code, mode, phase: 'lobby', players: [player(name), player(name2)], startAt: 0, endAt: 0, roundSeconds, serverTime: Date.now(), ledger: this.ledger.info, winner: null, fills: [] };
  }
  private async releasePrior(peer: Peer, except?: Room): Promise<void> {
    if (!peer.room) return;
    if (peer.room === except) return;
    if (!terminal(peer.room) && peer.room.state.phase !== 'lobby') throw new Error('Leave the current duel before opening another');
    const prior = peer.room;
    if (!terminal(prior)) await this.enqueue(prior, () => this.voidRoom(prior, 'The host opened another room. Stakes were returned.'));
    this.detach(peer); this.peers.add(peer); peer.room = undefined;
  }
  private async create(peer: Peer, message: Extract<ClientMessage, { type: 'create' }>): Promise<void> {
    if (message.mode !== 'local' && message.mode !== 'online') throw new Error('Choose couch or online mode');
    if (message.roundSeconds !== undefined && !isRoundDuration(message.roundSeconds)) throw new Error('Choose a round length from 1 to 5 minutes in whole minutes.');
    if (this.rooms.size >= 100) throw new Error('The arena is full. Try again shortly.');
    if (message.visibility !== undefined && message.visibility !== 'public' && message.visibility !== 'private') throw new Error('Choose a public or private room.');
    const stake = message.stake === undefined ? undefined : validateStake(message.stake);
    if (message.fundingMode !== undefined && message.fundingMode !== 'demo' && message.fundingMode !== 'monad-testnet') throw new Error('Unknown funding mode.');
    const onchain = message.fundingMode === 'monad-testnet';
    const walletAddress = this.bank.walletAddress(peer.accountId);
    if (onchain && (!stake || stake.asset !== 'MON' || message.mode !== 'online')) throw new Error('Monad testnet rooms require a MON stake and two online players.');
    if (onchain && !walletAddress) throw new Error('Connect and sign in with your Monad testnet wallet first.');
    const contractAddress = onchain ? this.escrow.requireAddress() : undefined;
    await this.releasePrior(peer);
    let code: string;
    do { code = randomBytes(4).toString('hex').slice(0, 6).toUpperCase(); } while (this.rooms.has(code));
    const state = this.initialState(
      code,
      message.mode,
      cleanName(message.name, 'Player one'),
      cleanName(message.name2, message.mode === 'local' ? 'Player two' : 'Waiting for rival'),
      message.roundSeconds,
    );
    const room: Room = { state, owners: [], queue: Promise.resolve(), pendingTick: false, registered: false, seen: new Set(), lastQuoteAt: Date.now(), lastSampleAt: 0, lastTouchedAt: Date.now(), visibility: message.visibility ?? 'public', createdAt: Date.now() };
    const seats = message.mode === 'local' ? [0, 1] : [0];
    if (stake) {
      room.state.stake = stake;
      if (onchain) {
        const key = roomKey(room.state.id);
        room.state.funding = { mode: 'monad-testnet', roomId: key, escrowRoomId: key, contractAddress: contractAddress!, chainId: 10143, hostFunded: false, guestFunded: false, status: 'awaiting-host', refundAfter: Math.floor(Date.now() / 1000) + 86_400, hostAddress: walletAddress! };
        await this.persist(room);
      } else { await this.bank.reserve(room.state.id, peer.accountId, seats, stake); room.state.stakeStatus = 'reserved'; }
    }
    this.rooms.set(code, room);
    this.attach(peer, room, { token: randomBytes(32).toString('hex'), seats, accountId: peer.accountId, walletAddress });
  }
  private async join(peer: Peer, message: Extract<ClientMessage, { type: 'join' }>): Promise<void> {
    if (typeof message.code !== 'string') throw new Error('Enter a six-character room code');
    const room = this.rooms.get(message.code.trim().toUpperCase());
    if (!room) throw new Error('No duel found with that code');
    await this.enqueue(room, async () => {
      if (room.state.mode !== 'online' || room.state.phase !== 'lobby') throw new Error('This duel is not accepting a new rival');
      if (room.owners.some(owner => owner.seats.includes(1))) throw new Error('Both seats are already taken');
      const walletAddress = this.bank.walletAddress(peer.accountId);
      if (room.state.stake && room.owners.some(owner => owner.accountId === peer.accountId)) throw new Error('Use a second browser profile for the other player, or create a same-screen room.');
      if (room.state.funding) {
        if (!walletAddress) throw new Error('Sign in with your Monad testnet wallet before joining.');
        if (getAddress(walletAddress) === getAddress(room.state.funding.hostAddress)) throw new Error('The opponent must use a different wallet.');
        await this.syncFundingRoom(room);
        if (!room.state.funding.hostFunded || room.state.funding.status !== 'open') throw new Error('The host has not funded an open escrow room.');
      }
      await this.releasePrior(peer, room);
      if (room.state.stake && !room.state.funding) await this.bank.reserve(room.state.id, peer.accountId, [1], room.state.stake);
      room.state.players[1].name = cleanName(message.name, 'Player two');
      if (room.state.funding) { room.state.funding.guestAddress = walletAddress; await this.persist(room); }
      this.attach(peer, room, { token: randomBytes(32).toString('hex'), seats: [1], accountId: peer.accountId, walletAddress });
    });
  }
  private async resume(peer: Peer, message: Extract<ClientMessage, { type: 'resume' }>): Promise<void> {
    if (typeof message.code !== 'string' || typeof message.token !== 'string' || !/^[0-9a-f]{64}$/.test(message.token)) throw new Error('Invalid recovery session');
    const room = this.rooms.get(message.code.toUpperCase());
    const owner = room?.owners.find(x => safeTokenEqual(x.token, message.token));
    if (!room || !owner) throw new Error('This recovery session is no longer available');
    if (!terminal(room) && room.state.phase !== 'lobby' && owner.seats.some(i => room.state.players[i].disconnectedAt && Date.now() - room.state.players[i].disconnectedAt! > this.options.recoveryMs)) throw new Error('The 20-second recovery window has expired');
    if (room.state.stake && owner.accountId !== peer.accountId) throw new Error('This room belongs to another demo wallet.');
    if (room.state.funding && owner.walletAddress !== this.bank.walletAddress(peer.accountId)) throw new Error('Sign in with the wallet that owns this room.');
    await this.releasePrior(peer, room);
    if (owner.peer && owner.peer !== peer) { owner.peer.room = undefined; owner.peer.ws.close(4001, 'Session resumed in another tab'); }
    this.attach(peer, room, owner);
  }
  private attach(peer: Peer, room: Room, owner: Owner): void {
    if (!room.owners.includes(owner)) room.owners.push(owner);
    owner.peer = peer; peer.room = room; peer.seats = owner.seats; peer.token = owner.token;
    room.lastTouchedAt = Date.now();
    for (const seat of owner.seats) { room.state.players[seat].connected = true; delete room.state.players[seat].disconnectedAt; }
    send(peer, { type: 'welcome', code: room.state.code, token: owner.token, seats: owner.seats });
    this.broadcast(room);
  }
  private async action(room: Room, seat: number, action: InputAction, market: number | undefined, inputId: string): Promise<void> {
    const p = room.state.players[seat];
    if (action === 'previous' || action === 'next' || action === 'select') {
      if (action === 'select') { if (!Number.isInteger(market) || market! < 0 || market! >= COINS.length) throw new Error('Unknown market'); p.selected = market!; }
      else p.selected = (p.selected + (action === 'next' ? 1 : COINS.length - 1)) % COINS.length;
      this.feedback(room, seat, 'select', `${COINS[p.selected]} selected`, inputId); this.broadcast(room); return;
    }
    if (action === 'marginDown' || action === 'marginUp') {
      const index = MARGINS.indexOf(p.margin as typeof MARGINS[number]);
      p.margin = MARGINS[Math.max(0, Math.min(MARGINS.length - 1, index + (action === 'marginUp' ? 1 : -1)))];
      this.feedback(room, seat, 'select', `$${p.margin} order margin`, inputId); this.broadcast(room); return;
    }
    if (action === 'ready') {
      if (room.state.phase !== 'lobby') throw new Error('Ready is available in the lobby');
      if (room.state.funding) { await this.syncFundingRoom(room); if (!room.state.funding.hostFunded || !room.state.funding.guestFunded || room.state.funding.status !== 'funded') throw new Error('Both MON stakes must be confirmed on Monad testnet before readying.'); }
      p.ready = !p.ready;
      this.feedback(room, seat, 'ready', p.ready ? 'Ready to duel' : 'Ready cancelled', inputId);
      this.broadcast(room);
      if (room.state.players.every(x => x.connected && x.ready)) await this.begin(room);
      return;
    }
    if (action === 'up' || action === 'down') throw new Error('Vertical navigation must select a market for the current screen layout.');
    if (room.state.phase !== 'active' || Date.now() < room.state.startAt || Date.now() >= room.state.endAt) throw new Error('Paper trading is only available during the live round');
    if (p.disabled) throw new Error('Risk floor reached. This account is locked for the round.');
    const quotes = this.feed.quotes();
    if (!quotes) throw new Error('Market data is unavailable or older than five seconds. Order blocked.');
    const result = await this.ledger.trade(room.state.id, seat, p.selected, action, p.margin, p.nonce + 1, quotes);
    this.apply(room, result.snapshot);
    const fills = result.fills ?? (result.fill ? [{ action, ...result.fill }] : []);
    if (fills.length) {
      for (const fill of fills) room.state.fills.unshift({ id: randomUUID(), time: Date.now(), seat, coin: COINS[p.selected], ...fill, txHash: result.txHash });
      room.state.fills = room.state.fills.slice(0, 200);
      const completed = fills.some(fill => fill.action === action);
      const message = !completed && p.disabled ? `${COINS[p.selected]} position closed. Risk floor prevents new exposure.` : `${COINS[p.selected]} ${action === 'long' ? 'long filled' : action === 'short' ? 'short filled' : action === 'half' ? 'half closed' : 'position closed'}`;
      this.feedback(room, seat, p.disabled ? 'risk' : 'fill', message, inputId);
    } else this.feedback(room, seat, 'risk', 'The ledger applied a risk closure. No new order was filled.', inputId);
    await this.persist(room);
    this.broadcast(room);
  }
  private async begin(room: Room): Promise<void> {
    const funding = room.state.funding;
    if (funding) await this.syncFundingRoom(room);
    const roundSeconds = room.state.roundSeconds ?? Math.ceil(this.options.roundMs / 1000);
    const startAt = (Math.floor(Date.now() / 1000) + Math.max(2, Math.ceil(this.options.countdownMs / 1000)) + 1) * 1000;
    const endAt = startAt + roundSeconds * 1000;
    if (funding && (funding.status !== 'funded' || funding.refundAfter * 1000 <= endAt + 60_000)) {
      room.state.players.forEach(p => p.ready = false);
      this.feedbackAll(room, 'Both stakes must be confirmed with enough time before the escrow refund deadline.');
      this.broadcast(room);
      return;
    }
    if (!this.feed.quotes()) { room.state.players.forEach(p => p.ready = false); this.feedbackAll(room, 'Live market data must be fresh before the round starts. Ready again when the feed recovers.'); this.broadcast(room); return; }
    room.state.phase = 'registering';
    room.state.startAt = startAt;
    room.state.endAt = endAt;
    this.broadcast(room);
    try {
      const snapshot = await this.ledger.create(room.state.id, room.state.startAt, room.state.endAt);
      room.registered = true;
      this.apply(room, snapshot);
      if (Date.now() >= room.state.startAt) return await this.voidRoom(room, 'Ledger registration exceeded the countdown window. Ready again for a new round.');
      room.state.phase = 'countdown'; room.lastQuoteAt = Date.now();
      await this.persist(room); this.broadcast(room);
    } catch (error) { await this.voidRoom(room, `Ledger registration failed: ${readableError(error)}`); }
  }
  private tick(): void {
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      if (room.state.phase === 'lobby' && !room.pendingTick && room.state.players.some(p => p.disconnectedAt && !p.connected && now - p.disconnectedAt > this.options.recoveryMs)) {
        room.pendingTick = true;
        void this.enqueue(room, async () => { try { await this.voidRoom(room, 'A player did not reconnect. The room was cancelled.'); } finally { room.pendingTick = false; } });
        continue;
      }
      if ((terminal(room) || room.state.phase === 'lobby') && now - room.lastTouchedAt > 60 * 60_000 && !room.owners.some(x => x.peer)) { this.rooms.delete(code); continue; }
      if (terminal(room) || room.state.phase === 'lobby' || room.state.phase === 'registering' || room.pendingTick) continue;
      room.pendingTick = true;
      void this.enqueue(room, async () => {
        try {
          const now = Date.now();
          if (terminal(room)) return;
          if (room.state.players.some(p => !p.connected && p.disconnectedAt && now - p.disconnectedAt > this.options.recoveryMs)) return await this.voidRoom(room, 'A player did not reconnect within 20 seconds. This round is void.');
          if (room.state.phase === 'countdown' && now >= room.state.startAt) { room.state.phase = 'active'; this.broadcast(room); }
          if (room.state.phase !== 'active') return;
          if (now >= room.state.endAt) {
            room.finalSnapshot = this.feed.quotes(room.state.endAt) ?? undefined;
            if (!room.finalSnapshot) return await this.voidRoom(room, 'No fresh shared market snapshot was available at the deadline. This round is void.');
            room.state.phase = 'settling'; this.broadcast(room);
            try {
              this.apply(room, await this.ledger.settle(room.state.id, room.finalSnapshot));
              if (room.state.stake && !room.state.funding) room.state.stakeStatus = await this.bank.resolve(room.state.id, room.state.winner);
              if (room.state.funding) room.state.funding.status = 'claimable';
              room.state.phase = 'finished'; await this.finishRecord(room); this.broadcast(room);
            } catch (error) { await this.voidRoom(room, `Settlement could not be confirmed: ${readableError(error)}`); }
            return;
          }
          const quotes = this.feed.quotes();
          if (quotes) room.lastQuoteAt = now;
          else if (now - room.lastQuoteAt > this.options.outageMs) return await this.voidRoom(room, 'Market data was unavailable for over 20 seconds. This round is void.');
          if (quotes && now - room.lastSampleAt >= 1_000) {
            room.lastSampleAt = now;
            try { this.apply(room, await this.ledger.update(room.state.id, quotes)); this.broadcast(room); }
            catch (error) {
              // A heartbeat accepted before the cutoff may estimate or mine after
              // it. Stop submitting updates and let the next tick settle the
              // frozen deadline snapshot, instead of invalidating a fair round.
              if (Date.now() < room.state.endAt) await this.voidRoom(room, `Ledger synchronization failed: ${readableError(error)}`);
            }
          }
        } finally { room.pendingTick = false; }
      });
    }
  }
  private apply(room: Room, snapshot: LedgerSnapshot): void {
    snapshot.accounts.forEach((account, seat) => {
      const wasDisabled = room.state.players[seat].disabled;
      Object.assign(room.state.players[seat], account);
      if (account.disabled && !wasDisabled) this.feedback(room, seat, 'risk', 'Risk floor reached. All positions closed; account locked.');
    });
    room.state.winner = snapshot.winner;
    if (snapshot.txHash) room.state.txHash = snapshot.txHash;
  }
  private async voidRoom(room: Room, reason: string): Promise<void> {
    if (terminal(room)) return;
    if (room.state.stake && !room.state.funding) room.state.stakeStatus = await this.bank.resolve(room.state.id, null);
    if (room.state.funding && room.state.funding.guestFunded) room.state.funding.status = 'claimable';
    room.state.phase = 'void'; room.state.reason = reason; room.state.winner = null;
    if (room.registered) { try { await this.ledger.void(room.state.id, reason); } catch { room.state.reason += ' The relayer could not confirm the void transaction.'; } }
    await this.finishRecord(room); this.broadcast(room);
  }
  private feedback(room: Room, seat: number, kind: Extract<ServerMessage, { type: 'feedback' }>['kind'], message: string, id?: string): void {
    for (const owner of room.owners) if (owner.peer) send(owner.peer, { type: 'feedback', seat, kind, message, id });
  }
  private feedbackAll(room: Room, message: string): void { for (let seat = 0; seat < 2; seat++) this.feedback(room, seat, 'reject', message); }
  private broadcast(room: Room): void {
    room.state.serverTime = Date.now();
    for (const owner of room.owners) if (owner.peer) send(owner.peer, { type: 'state', state: room.state });
  }
  private enqueue(room: Room, task: () => Promise<void>): Promise<void> {
    const next = room.queue.then(task);
    room.queue = next.catch(() => {});
    return next;
  }
  private control(task: () => Promise<void>): Promise<void> {
    const next = this.controlQueue.then(task);
    this.controlQueue = next.catch(() => {});
    return next;
  }
  private async syncFundingRoom(room: Room): Promise<void> {
    const funding = room.state.funding;
    if (!funding || !room.state.stake) return;
    const chain = await this.escrow.verifyRoom(funding.roomId, funding.hostAddress, funding.guestAddress, room.state.stake.amount, funding.refundAfter);
    funding.hostFunded = chain.status > 0;
    funding.guestFunded = chain.status >= 2 && chain.opponent !== ZeroAddress && Boolean(funding.guestAddress) && chain.opponent === getAddress(funding.guestAddress!);
    if (chain.status === 4) { funding.status = 'refunded'; room.state.stakeStatus = 'refunded'; }
    else if (chain.status === 3) { funding.status = 'claimable'; room.state.stakeStatus = room.state.winner === null ? 'refunded' : 'paid'; }
    else if (terminal(room) && chain.status === 2) funding.status = 'claimable';
    else funding.status = chain.status === 0 ? 'awaiting-host' : funding.guestFunded ? 'funded' : 'open';
    if (funding.hostFunded && chain.status < 3) room.state.stakeStatus = 'reserved';
    if (chain.status === 4 && !terminal(room)) await this.voidRoom(room, 'The on-chain room was cancelled or refunded.');
    if (!terminal(room)) await this.persist(room);
    this.broadcast(room);
  }
  async syncFunding(code: string): Promise<MatchState> {
    const room = this.rooms.get(code.trim().toUpperCase());
    if (!room) throw new Error('No duel found with that code');
    if (room.state.phase === 'lobby' || terminal(room)) await this.enqueue(room, () => this.syncFundingRoom(room));
    return structuredClone(room.state);
  }
  getPublicRooms(): RoomSummary[] {
    return [...this.rooms.values()].filter(room => room.visibility === 'public' && room.state.mode === 'online' && room.state.phase === 'lobby' && room.state.players[0].connected && room.owners.length === 1 && (!room.state.funding || room.state.funding.hostFunded && room.state.funding.status === 'open')).map(room => ({ id: room.state.id, code: room.state.code, host: room.state.players[0].name, mode: room.state.mode, phase: room.state.phase, players: room.owners.reduce((count, owner) => count + owner.seats.length, 0), stake: room.state.stake ?? null, createdAt: room.createdAt, funding: room.state.funding, roundSeconds: room.state.roundSeconds })).sort((a, b) => b.createdAt - a.createdAt);
  }
  async getResolution(code: string) {
    const state = this.rooms.get(code.trim().toUpperCase())?.state ?? this.history.find(record => record.code === code.trim().toUpperCase());
    if (!state?.funding || !state.stake) throw new Error('This room has no Monad testnet escrow.');
    if (state.phase !== 'finished' && state.phase !== 'void') throw new Error('The match has not settled.');
    const funding = state.funding;
    const chain = await this.escrow.verifyRoom(funding.roomId, funding.hostAddress, funding.guestAddress, state.stake.amount, funding.refundAfter);
    if (chain.status !== 2) throw new Error(chain.status === 1 ? 'The host can cancel this unjoined room directly.' : 'This escrow is already resolved, refunded, or not funded.');
    if (Date.now() >= funding.refundAfter * 1000) throw new Error('The escrow deadline passed. Use the on-chain expired-room refund.');
    const winner = state.phase === 'void' || state.winner === null ? ZeroAddress : state.winner === 0 ? funding.hostAddress : funding.guestAddress;
    if (!winner) throw new Error('The settled winning wallet could not be verified.');
    return this.escrow.resolution({ roomId: funding.roomId, winner, deadline: Math.min(funding.refundAfter, Math.floor(Date.now() / 1000) + 900) }, funding.contractAddress);
  }
  private async writeRecord(state: MatchState, active: boolean): Promise<void> {
    const file = path.join(this.options.dataDir, active ? 'active' : 'matches', `${state.id}.json`);
    const temporary = `${file}.tmp`;
    await writeFile(temporary, JSON.stringify({ ...state, serverTime: Date.now() }, null, 2));
    await rename(temporary, file);
  }
  private persist(room: Room): Promise<void> { return this.writeRecord(room.state, true); }
  private async finishRecord(room: Room): Promise<void> {
    room.state.serverTime = Date.now();
    await this.writeRecord(room.state, false);
    await rm(path.join(this.options.dataDir, 'active', `${room.state.id}.json`), { force: true });
    this.history.unshift(structuredClone(room.state)); this.history = this.history.slice(0, 200);
  }
  getHistory(): MatchState[] { return this.history.slice(0, 30); }
  getRecord(id: string): MatchState | undefined { return this.history.find(x => x.id === id); }
  async close(): Promise<void> {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.broadcastTimer) clearInterval(this.broadcastTimer);
    await this.controlQueue;
    for (const room of this.rooms.values()) await room.queue;
    for (const peer of this.peers) peer.ws.close(1001, 'Server stopping');
    await this.bank.close(); await this.escrow.close();
  }
}
