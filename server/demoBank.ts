import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DemoSession, Stake, StakeAsset } from '../shared/types.ts';

const ASSETS: StakeAsset[] = ['MON', 'SOL', 'ETH'];
const SCALE = 1_000_000;
type Units = Record<StakeAsset, number>;
interface Wallet { id: string; tokenHash: string; units: Units; walletAddress?: string }
interface Reservation { asset: StakeAsset; units: number; seats: { seat: number; accountId: string }[] }
interface BankState { version: 1; wallets: Record<string, Wallet>; reservations: Record<string, Reservation>; closed: Record<string, 'paid' | 'refunded'> }
const zero = (): Units => ({ MON: 0, SOL: 0, ETH: 0 });
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const empty = (): BankState => ({ version: 1, wallets: {}, reservations: {}, closed: {} });

export function validateStake(value: unknown): Stake {
  const candidate = value as Partial<Stake> | null;
  if (!candidate || !ASSETS.includes(candidate.asset as StakeAsset)) throw new Error('Choose MON, SOL, or ETH.');
  const amount = candidate.amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0.000001 || amount > 1_000_000 || Math.abs(amount * SCALE - Math.round(amount * SCALE)) > 0.00001) throw new Error('Enter an amount from 0.000001 to 1,000,000 with at most six decimals.');
  return { asset: candidate.asset as StakeAsset, amount: Math.round(amount * SCALE) / SCALE };
}

/** Non-redeemable demo tokens. Integer accounting and atomic disk snapshots. */
export class DemoBank {
  private state: BankState = empty();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly directory: string) {}
  async start(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    try {
      const loaded = JSON.parse(await readFile(path.join(this.directory, 'demo-bank.json'), 'utf8')) as BankState;
      if (loaded.version !== 1 || !loaded.wallets || !loaded.reservations || !loaded.closed) throw new Error('Invalid demo-bank state');
      this.state = loaded;
    } catch (error: any) { if (error.code !== 'ENOENT') throw new Error('Demo balance storage could not be read. Existing balances were not reset.'); }
    // Room owners and the local EVM cannot survive a process restart.
    await this.change(draft => {
      for (const id of Object.keys(draft.reservations)) this.resolveDraft(draft, id, null);
    });
  }
  private change<T>(action: (draft: BankState) => T): Promise<T> {
    const operation = this.queue.then(async () => {
      const draft = structuredClone(this.state);
      const result = action(draft);
      const file = path.join(this.directory, 'demo-bank.json');
      await writeFile(`${file}.tmp`, JSON.stringify(draft));
      await rename(`${file}.tmp`, file);
      this.state = draft;
      return result;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  accountForToken(token: string | undefined): string | undefined {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return undefined;
    const tokenHash = hash(token);
    return Object.values(this.state.wallets).find(wallet => wallet.tokenHash === tokenHash)?.id;
  }
  async session(token?: string): Promise<{ accountId: string; token?: string; session: DemoSession }> {
    const existing = this.accountForToken(token);
    if (existing) return { accountId: existing, session: this.snapshot(existing) };
    const newToken = randomBytes(32).toString('hex');
    const accountId = randomUUID();
    await this.change(draft => { draft.wallets[accountId] = { id: accountId, tokenHash: hash(newToken), units: zero() }; });
    return { accountId, token: newToken, session: this.snapshot(accountId) };
  }
  /** Legacy non-browser clients have no cookie and cannot fund this identity. */
  guest(): string { return `guest-${randomUUID()}`; }
  snapshot(accountId: string): DemoSession {
    const wallet = this.state.wallets[accountId];
    if (!wallet) throw new Error('Open a demo wallet before adding a stake.');
    const reserved = zero();
    for (const reservation of Object.values(this.state.reservations)) for (const seat of reservation.seats) if (seat.accountId === accountId) reserved[reservation.asset] += reservation.units;
    return { accountId, mode: 'demo', balances: Object.fromEntries(ASSETS.map(asset => [asset, wallet.units[asset] / SCALE])) as Units, reserved: Object.fromEntries(ASSETS.map(asset => [asset, reserved[asset] / SCALE])) as Units, walletAddress: wallet.walletAddress };
  }
  walletAddress(accountId: string): string | undefined { return this.state.wallets[accountId]?.walletAddress; }
  async bindWallet(accountId: string, address: string): Promise<DemoSession> {
    await this.change(draft => {
      const wallet = draft.wallets[accountId];
      if (!wallet) throw new Error('Session expired. Refresh and sign in again.');
      wallet.walletAddress = address;
    });
    return this.snapshot(accountId);
  }
  async deposit(accountId: string, value: unknown): Promise<DemoSession> {
    const stake = validateStake(value);
    await this.change(draft => {
      const wallet = draft.wallets[accountId];
      if (!wallet) throw new Error('Open a demo wallet first.');
      const units = Math.round(stake.amount * SCALE);
      if (wallet.units[stake.asset] + units > 1_000_000_000 * SCALE) throw new Error('Demo balance limit reached.');
      wallet.units[stake.asset] += units;
    });
    return this.snapshot(accountId);
  }
  async reserve(id: string, accountId: string, seats: number[], stake: Stake): Promise<void> {
    await this.change(draft => {
      if (draft.closed[id]) throw new Error('This stake pool is already closed.');
      const wallet = draft.wallets[accountId];
      if (!wallet) throw new Error('Open a demo wallet and deposit before staking.');
      const units = Math.round(stake.amount * SCALE);
      const prior = draft.reservations[id];
      if (prior && (prior.asset !== stake.asset || prior.units !== units)) throw new Error('Both players must enter with the same stake.');
      if (seats.some(seat => prior?.seats.some(held => held.seat === seat))) throw new Error('This player stake is already reserved.');
      if (wallet.units[stake.asset] < units * seats.length) throw new Error(`Insufficient demo ${stake.asset}. Deposit before joining this duel.`);
      wallet.units[stake.asset] -= units * seats.length;
      const reservation = prior ?? { asset: stake.asset, units, seats: [] };
      reservation.seats.push(...seats.map(seat => ({ seat, accountId })));
      draft.reservations[id] = reservation;
    });
  }
  private resolveDraft(draft: BankState, id: string, winner: number | null): 'paid' | 'refunded' | undefined {
    if (draft.closed[id]) return draft.closed[id];
    const reservation = draft.reservations[id];
    if (!reservation) return undefined;
    const winningSeat = winner === 0 || winner === 1 ? reservation.seats.find(seat => seat.seat === winner) : undefined;
    const paid = reservation.seats.length === 2 && winningSeat !== undefined;
    if (paid) draft.wallets[winningSeat.accountId].units[reservation.asset] += reservation.units * 2;
    else for (const seat of reservation.seats) draft.wallets[seat.accountId].units[reservation.asset] += reservation.units;
    delete draft.reservations[id];
    return draft.closed[id] = paid ? 'paid' : 'refunded';
  }
  async resolve(id: string, winner: number | null): Promise<'paid' | 'refunded' | undefined> { return this.change(draft => this.resolveDraft(draft, id, winner)); }
  async close(): Promise<void> { await this.queue; }
}
