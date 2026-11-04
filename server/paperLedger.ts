import { parseUnits } from 'ethers';
import { COINS, MARGINS, type Account, type LedgerSnapshot, type Quote, type TradeAction } from '../shared/types.ts';
import type { MatchLedger, MatchTradeResult } from './matches.ts';

// Same scales, fills, and score rules as PaperDuel.sol.
const USD = 100_000_000n;
const QTY = 10n ** 18n;
const START = 1_000n * USD;
const FLOOR = 200n * USD;
const abs = (value: bigint) => value < 0n ? -value : value;
const dollars = (value: bigint) => Number(value) / Number(USD);
const units = (value: bigint) => Number(value) / Number(QTY);
const feeFor = (quantity: bigint, price: bigint) => quantity * price / QTY * 5n / 10_000n;
type Price = { mark: bigint; bid: bigint; ask: bigint; time: number };
type Position = { quantity: bigint; entry: bigint; margin: bigint };
type Book = ReturnType<typeof newBook>;
type Round = { startAt: number; endAt: number; books: [Book, Book]; quotes: Price[] };
type Execution = NonNullable<MatchTradeResult['fills']>[number];
const executionPrice = (quote: Price, buy: boolean) => buy ? quote.ask * 10_001n / 10_000n : quote.bid * 9_999n / 10_000n;

function newBook() {
  return {
    cash: START, realized: 0n, fees: 0n, peak: START, drawdown: 0n, disabled: false, nonce: 0,
    positions: COINS.map((): Position => ({ quantity: 0n, entry: 0n, margin: 0n })),
  };
}

function accountValues(book: Book, quotes: Price[]) {
  let pnl = 0n, margin = 0n;
  for (const [index, position] of book.positions.entries()) {
    if (position.quantity === 0n) continue;
    pnl += position.quantity * (quotes[index].mark - position.entry) / QTY;
    margin += position.margin;
  }
  const marked = book.cash + pnl;
  const equity = marked > 0n ? marked : 0n;
  const available = equity > margin ? equity - margin : 0n;
  return { pnl, margin, equity, available, score: equity - START - book.drawdown * 35n / 100n };
}

function closePosition(book: Book, market: number, quote: Price, quantity: bigint, action: 'half' | 'close'): Execution {
  const position = book.positions[market];
  const buy = position.quantity < 0n;
  const price = executionPrice(quote, buy);
  const signedQuantity = buy ? quantity : -quantity;
  const pnl = -signedQuantity * (price - position.entry) / QTY;
  const fee = feeFor(quantity, price);
  book.cash += pnl - fee;
  book.realized += pnl;
  book.fees += fee;
  position.margin -= position.margin * quantity / abs(position.quantity);
  position.quantity += signedQuantity;
  if (position.quantity === 0n) book.positions[market] = { quantity: 0n, entry: 0n, margin: 0n };
  return { action, quantity: units(signedQuantity), price: dollars(price), fee: dollars(fee) };
}

function track(book: Book, equity: bigint) {
  if (equity > book.peak) book.peak = equity;
  if (book.peak - equity > book.drawdown) book.drawdown = book.peak - equity;
}

function closeAll(book: Book, quotes: Price[]) {
  for (const [market, position] of book.positions.entries()) {
    if (position.quantity !== 0n) closePosition(book, market, quotes[market], abs(position.quantity), 'close');
  }
}

function sample(book: Book, quotes: Price[]) {
  const { equity } = accountValues(book, quotes);
  track(book, equity);
  if (!book.disabled && equity <= FLOOR) {
    book.disabled = true;
    closeAll(book, quotes);
    track(book, accountValues(book, quotes).equity);
  }
}

function snapshot(round: Round, winner: number | null = null): LedgerSnapshot {
  const view = (book: Book): Account => {
    const { pnl, margin, equity, available, score } = accountValues(book, round.quotes);
    return {
      cash: dollars(book.cash), realizedPnl: dollars(book.realized), fees: dollars(book.fees),
      equity: dollars(equity), unrealizedPnl: dollars(pnl), reservedMargin: dollars(margin),
      availableMargin: dollars(available), peakEquity: dollars(book.peak), maxDrawdown: dollars(book.drawdown),
      score: dollars(score), disabled: book.disabled, nonce: book.nonce,
      positions: book.positions.flatMap((position, market) => position.quantity === 0n ? [] : [{
        coin: COINS[market], quantity: units(position.quantity), entry: dollars(position.entry),
        margin: dollars(position.margin),
        unrealizedPnl: dollars(position.quantity * (round.quotes[market].mark - position.entry) / QTY),
      }]),
    };
  };
  return { accounts: [view(round.books[0]), view(round.books[1])], winner };
}

export class PaperLedger implements MatchLedger {
  readonly info = { mode: 'paper' } as const;
  private readonly rounds = new Map<string, Round>();

  private round(id: string): Round {
    const round = this.rounds.get(id);
    if (!round) throw new Error('Match is not open in the paper ledger.');
    return round;
  }

  private mark(round: Round, quotes: Quote[], at: number) {
    if (quotes.length !== COINS.length) throw new Error('All six market quotes are required.');
    round.quotes = quotes.map((quote, market) => {
      const { mark, bid, ask, time } = quote;
      if (quote.coin !== COINS[market] || ![mark, bid, ask, time].every(Number.isFinite) ||
          mark < 1e-8 || bid < 1e-8 || ask < bid || ask > 1e12 || mark > 1e12) {
        throw new Error('Invalid market quote.');
      }
      if (time > at || time < at - 5_000 || time < (round.quotes[market]?.time ?? 0)) {
        throw new Error('Market quote is stale or out of order.');
      }
      return { mark: parseUnits(mark.toFixed(8), 8), bid: parseUnits(bid.toFixed(8), 8), ask: parseUnits(ask.toFixed(8), 8), time };
    });
    for (const book of round.books) sample(book, round.quotes);
  }

  private active(id: string, now: number) {
    const round = this.round(id);
    if (now < round.startAt || now >= round.endAt) throw new Error('This duel is outside its trading window.');
    return round;
  }

  async create(id: string, startAt: number, endAt: number) {
    if (this.rounds.has(id) || startAt < Date.now() || endAt <= startAt) throw new Error('Invalid paper round clock.');
    const round: Round = { startAt, endAt, books: [newBook(), newBook()], quotes: [] };
    this.rounds.set(id, round);
    return snapshot(round);
  }

  async update(id: string, quotes: Quote[]) {
    const now = Date.now();
    const round = this.active(id, now);
    this.mark(round, quotes, now);
    return snapshot(round);
  }

  async trade(id: string, seat: number, market: number, action: TradeAction, margin: number, nonce: number, quotes: Quote[]): Promise<MatchTradeResult> {
    const now = Date.now();
    const round = this.active(id, now);
    const current = round.books[seat];
    if (!current || !Number.isInteger(market) || market < 0 || market >= COINS.length) throw new Error('Invalid paper order.');
    if (current.disabled) throw new Error('Risk floor reached. This account is locked for the round.');
    if (nonce !== current.nonce + 1) throw new Error('This action was already processed or arrived out of order.');
    this.mark(round, quotes, now);
    if (current.disabled) return { snapshot: snapshot(round), fills: [] };

    // Keep quote/risk sampling even if the order fails. Commit a reversal only
    // after the replacement order passes the margin check.
    const book = structuredClone(current);
    const quote = round.quotes[market];
    const existing = book.positions[market];
    const fills: Execution[] = [];
    if (action === 'half' || action === 'close') {
      const quantity = abs(existing.quantity) / (action === 'half' ? 2n : 1n);
      if (!quantity) throw new Error('There is no position to close on this market.');
      fills.push(closePosition(book, market, quote, quantity, action));
    } else {
      if (!MARGINS.some(value => value === margin)) throw new Error('Invalid order margin.');
      const buy = action === 'long';
      if (existing.quantity !== 0n && (existing.quantity > 0n) !== buy) {
        fills.push(closePosition(book, market, quote, abs(existing.quantity), 'close'));
        sample(book, round.quotes);
      }
      if (!book.disabled) {
        const price = executionPrice(quote, buy);
        if (!price) throw new Error('Invalid execution price.');
        const collateral = BigInt(margin) * USD;
        const quantity = collateral * 3n * QTY / price;
        const signed = buy ? quantity : -quantity;
        const fee = feeFor(quantity, price);
        const spreadCost = signed * (price - quote.mark) / QTY;
        if (accountValues(book, round.quotes).available < collateral + fee + (spreadCost > 0n ? spreadCost : 0n)) {
          throw new Error('Not enough available margin including spread, slippage and fees.');
        }
        const position = book.positions[market];
        const oldQuantity = abs(position.quantity);
        position.entry = (oldQuantity * position.entry + quantity * price) / (oldQuantity + quantity);
        position.quantity += signed;
        position.margin += collateral;
        book.cash -= fee;
        book.fees += fee;
        fills.push({ action, quantity: units(signed), price: dollars(price), fee: dollars(fee) });
      }
    }
    book.nonce = nonce;
    sample(book, round.quotes);
    round.books[seat] = book;
    return { snapshot: snapshot(round), fills };
  }

  async settle(id: string, quotes: Quote[]) {
    const round = this.round(id);
    if (Date.now() < round.endAt) throw new Error('The paper round is still active.');
    this.mark(round, quotes, round.endAt);
    for (const book of round.books) {
      closeAll(book, round.quotes);
      track(book, accountValues(book, round.quotes).equity);
    }
    const [left, right] = round.books.map(book => accountValues(book, round.quotes));
    const [leftBook, rightBook] = round.books;
    const winner = left.score !== right.score ? (left.score > right.score ? 0 : 1)
      : leftBook.drawdown !== rightBook.drawdown ? (leftBook.drawdown < rightBook.drawdown ? 0 : 1) : null;
    this.rounds.delete(id);
    return snapshot(round, winner);
  }

  async read(id: string) { return snapshot(this.round(id)); }
  async void(id: string) { this.rounds.delete(id); }
  async receipt(_hash: string) { return null; }
  async close() { this.rounds.clear(); }
}
