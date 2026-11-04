import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { clockCalibration, FixtureFeed, HyperliquidFeed } from '../server/markets.ts';
import { COINS, DEFAULT_ROUND_SECONDS } from '../shared/types.ts';
import { blankAccount, MatchManager, type MatchLedger, type MatchOptions } from '../server/matches.ts';
import type { LedgerSnapshot, ServerMessage } from '../shared/types.ts';

const mockLedger = (): MatchLedger => {
  const snapshot = (): LedgerSnapshot => ({ accounts: [blankAccount(), blankAccount()], winner: null });
  return { info: { mode: 'local-evm', chainId: 31337, contractAddress: '0x123', relayerAddress: '0x456' }, create: async () => snapshot(), update: async () => snapshot(), trade: async () => ({ snapshot: snapshot(), txHash: '0x1' }), settle: async () => snapshot(), read: async () => snapshot(), void: async () => {}, close: async () => {} };
};
function socket() {
  const messages: ServerMessage[] = [];
  const ws = { readyState: WebSocket.OPEN, send: (text: string) => messages.push(JSON.parse(text)), close: () => {} } as unknown as WebSocket;
  return { ws, messages };
}
async function harness(options: Partial<MatchOptions> = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'trading-duel-server-'));
  const feed = new FixtureFeed(); await feed.start();
  const manager = new MatchManager(mockLedger(), feed, { roundMs: 300_000, countdownMs: 5_000, recoveryMs: 20_000, outageMs: 20_000, dataDir: dir, ...options });
  await manager.start();
  return { manager, feed, async close() { await manager.close(); feed.stop(); await rm(dir, { recursive: true, force: true }); } };
}
async function waitUntil(predicate: () => boolean, timeout = 6_000) {
  const started = Date.now();
  while (!predicate()) { if (Date.now() - started > timeout) throw new Error('Server state did not reach the expected condition'); await new Promise(resolve => setTimeout(resolve, 25)); }
}
async function readyCouch(manager: MatchManager) {
  const a = socket(), peer = manager.add(a.ws);
  await manager.handle(peer, { type: 'create', mode: 'local', name: 'One', name2: 'Two' });
  const welcome = a.messages.find(x => x.type === 'welcome'); assert.ok(welcome?.type === 'welcome');
  await manager.handle(peer, { type: 'action', seat: 0, id: 'ready0', action: 'ready' });
  await manager.handle(peer, { type: 'action', seat: 1, id: 'ready1', action: 'ready' });
  return { peer, room: manager.rooms.get(welcome.code)!, messages: a.messages };
}

test('online seats are owned, room codes work, and action ids are idempotent', async () => {
  const h = await harness();
  try {
    const a = socket(), b = socket();
    const pa = h.manager.add(a.ws), pb = h.manager.add(b.ws);
    await h.manager.handle(pa, { type: 'create', mode: 'online', name: 'Alpha' });
    const welcome = a.messages.find(x => x.type === 'welcome'); assert.ok(welcome?.type === 'welcome');
    assert.equal(h.manager.getPublicRooms()[0]?.roundSeconds, DEFAULT_ROUND_SECONDS);
    await h.manager.handle(pb, { type: 'join', code: welcome.code.toLowerCase(), name: 'Beta' });
    assert.deepEqual(pa.seats, [0]); assert.deepEqual(pb.seats, [1]);
    await assert.rejects(() => h.manager.handle(pa, { type: 'action', seat: 1, id: 'steal', action: 'long' }), /belongs to another/);
    await h.manager.handle(pa, { type: 'action', seat: 0, id: 'move', action: 'next' });
    await h.manager.handle(pa, { type: 'action', seat: 0, id: 'move', action: 'next' });
    const state = a.messages.filter(x => x.type === 'state').at(-1); assert.ok(state?.type === 'state');
    assert.equal(state.state.players[0].selected, 1);
    assert.equal(state.state.players[1].selected, 0);
    await assert.rejects(() => h.manager.handle(pb, { type: 'join', code: welcome.code, name: 'Third' }), /already taken/);
  } finally { await h.close(); }
});

test('the host selects a supported round length shared by both seats and rematches', async () => {
  const h = await harness();
  try {
    const a = socket(), b = socket();
    const pa = h.manager.add(a.ws), pb = h.manager.add(b.ws);
    const create = { type: 'create', mode: 'online', name: 'Host' };
    for (const invalid of [null, '60', 30, 90, 360]) {
      await assert.rejects(() => h.manager.handle(pa, { ...create, roundSeconds: invalid }), /whole minutes/);
    }
    await h.manager.handle(pa, { ...create, roundSeconds: 120 });
    const welcome = a.messages.find(message => message.type === 'welcome');
    assert.ok(welcome?.type === 'welcome');
    assert.equal(h.manager.getPublicRooms()[0]?.roundSeconds, 120);

    await h.manager.handle(pb, { type: 'join', code: welcome.code, name: 'Rival' });
    await h.manager.handle(pa, { type: 'action', seat: 0, id: 'hostReady', action: 'ready' });
    await h.manager.handle(pb, { type: 'action', seat: 1, id: 'rivalReady', action: 'ready' });
    for (const { messages } of [a, b]) {
      const latest = messages.filter(message => message.type === 'state').at(-1);
      assert.ok(latest?.type === 'state');
      assert.equal(latest.state.phase, 'countdown');
      assert.equal(latest.state.roundSeconds, 120);
      assert.equal(latest.state.endAt - latest.state.startAt, 120_000);
    }

    await h.manager.handle(pb, { type: 'leave' });
    await h.manager.handle(pa, { type: 'rematch' });
    const latest = a.messages.filter(message => message.type === 'state').at(-1);
    assert.ok(latest?.type === 'state');
    assert.equal(latest.state.phase, 'lobby');
    assert.equal(latest.state.roundSeconds, 120);
  } finally { await h.close(); }
});

test('couch controls keep two independent seats, wrap markets and clamp order margins', async () => {
  const h = await harness();
  try {
    const a = socket(); const p = h.manager.add(a.ws);
    await h.manager.handle(p, { type: 'create', mode: 'local', name: 'One', name2: 'Two' });
    assert.deepEqual(p.seats, [0, 1]);
    await h.manager.handle(p, { type: 'action', seat: 0, id: 'back', action: 'previous' });
    await h.manager.handle(p, { type: 'action', seat: 1, id: 'forward', action: 'next' });
    for (let n = 0; n < 4; n++) await h.manager.handle(p, { type: 'action', seat: 1, id: `margin${n}`, action: 'marginUp' });
    const state = a.messages.filter(x => x.type === 'state').at(-1); assert.ok(state?.type === 'state');
    assert.equal(state.state.players[0].selected, 5); assert.equal(state.state.players[1].selected, 1);
    assert.equal(state.state.players[0].margin, 100); assert.equal(state.state.players[1].margin, 500);
    await h.manager.handle(p, { type: 'action', seat: 0, id: 'early', action: 'long' });
    assert.ok(a.messages.some(x => x.type === 'feedback' && x.kind === 'reject' && x.message.includes('live round')));
  } finally { await h.close(); }
});

test('recovery requires the actual secret token and cannot capture another player seat', async () => {
  const h = await harness();
  try {
    const a = socket(), b = socket(); const pa = h.manager.add(a.ws), pb = h.manager.add(b.ws);
    await h.manager.handle(pa, { type: 'create', mode: 'online', name: 'One' });
    const welcome = a.messages.find(x => x.type === 'welcome'); assert.ok(welcome?.type === 'welcome');
    h.manager.detach(pa);
    await assert.rejects(() => h.manager.handle(pb, { type: 'resume', code: welcome.code, token: '0'.repeat(64) }), /no longer available/);
    await h.manager.handle(pb, { type: 'resume', code: welcome.code, token: welcome.token });
    assert.deepEqual(pb.seats, [0]);
    const state = b.messages.filter(x => x.type === 'state').at(-1); assert.ok(state?.type === 'state');
    assert.equal(state.state.players[0].connected, true);
  } finally { await h.close(); }
});

test('stale fixture quotes become unavailable and the deadline snapshot excludes later observations', async () => {
  const feed = new FixtureFeed(); await feed.start();
  try {
    const cutoff = Date.now();
    const before = feed.quotes(cutoff); assert.ok(before);
    await new Promise(resolve => setTimeout(resolve, 250));
    const frozen = feed.quotes(cutoff); assert.deepEqual(frozen, before);
    assert.ok(feed.quotes()!.every(q => q.time > before[0].time));
    assert.equal(feed.quotes(Date.now() + 6000), null);
    assert.ok(feed.snapshot(Date.now() + 6000).every(x => !x.available));
  } finally { feed.stop(); }
});

test('malformed and excessive inputs fail without changing account balances', async () => {
  const h = await harness();
  try {
    const a = socket(); const p = h.manager.add(a.ws);
    await assert.rejects(() => h.manager.handle(p, null), /Invalid message/);
    await h.manager.handle(p, { type: 'create', mode: 'local', name: 'One' });
    await assert.rejects(() => h.manager.handle(p, { type: 'action', seat: 0, id: '', action: 'long' }), /unique action id/);
    await h.manager.handle(p, { type: 'action', seat: 0, id: 'selectbad', action: 'select', market: 99 });
    assert.ok(a.messages.some(x => x.type === 'feedback' && x.kind === 'reject' && x.message.includes('Unknown market')));
    for (let n = 0; n < 30; n++) await h.manager.handle(p, { type: 'ping', time: Date.now() });
    assert.ok(a.messages.some(x => x.type === 'error' && x.message.includes('Too many')));
    const state = a.messages.filter(x => x.type === 'state').at(-1); assert.ok(state?.type === 'state');
    assert.equal(state.state.players[0].equity, 1000);
  } finally { await h.close(); }
});

test('HTTPS Date calibration conservatively ages quotes despite local skew and response latency', () => {
  const base = 1_700_000_000_000;
  for (const skew of [-9_000, 0, 5_000]) for (const latency of [20, 600, 1_500]) {
    const trueRequest = base + 100;
    const trueResponse = trueRequest + latency;
    const serverDate = new Date(Math.floor((trueRequest + latency / 2) / 1000) * 1000).toUTCString();
    const calibration = clockCalibration(trueRequest + skew, trueResponse + skew, serverDate);
    assert.ok(calibration);
    const rawQuoteTime = trueResponse - 700;
    const actualAge = trueResponse - rawQuoteTime;
    const normalizedAge = trueResponse + skew - (rawQuoteTime + calibration.offsetMs);
    assert.ok(normalizedAge >= actualAge, 'normalization must never understate age');
    const staleQuoteTime = trueResponse - 5_001;
    assert.ok(trueResponse + skew - (staleQuoteTime + calibration.offsetMs) > 5_000, 'an old quote must stay old');
  }
});

test('clock calibration rejects missing dates, excessive skew, and unbounded transport latency', () => {
  const base = 1_700_000_000_000, date = new Date(base).toUTCString();
  assert.equal(clockCalibration(base, base + 100, null), null);
  assert.equal(clockCalibration(base, base + 100, 'invalid'), null);
  assert.equal(clockCalibration(base + 90_000, base + 90_100, date), null);
  assert.equal(clockCalibration(base, base + 10_001, date), null);
  assert.equal(clockCalibration(base + 100, base, date), null);
});

test('an unrecovered browser interruption voids the casual duel after its recovery window', async () => {
  const h = await harness({ countdownMs: 1_000, recoveryMs: 120 });
  try {
    const { peer, room } = await readyCouch(h.manager);
    assert.equal(room.state.phase, 'countdown');
    h.manager.detach(peer);
    await waitUntil(() => h.manager.getHistory().some(record => record.id === room.state.id && record.phase === 'void'));
    assert.match(room.state.reason!, /did not reconnect/);
    assert.equal(room.state.winner, null); assert.equal(room.state.fills.length, 0);
    assert.equal(h.manager.getHistory().find(record => record.id === room.state.id)?.phase, 'void');
  } finally { await h.close(); }
});

test('an extended missing market feed voids a running duel rather than inventing a fill', { timeout: 12_000 }, async () => {
  const h = await harness({ countdownMs: 1_000, outageMs: 200 });
  try {
    const { room } = await readyCouch(h.manager);
    await waitUntil(() => room.state.phase === 'active');
    h.feed.paused = true;
    h.feed.quotes = () => null; // Explicitly inject provider unavailability.
    await waitUntil(() => room.state.phase === 'void');
    assert.match(room.state.reason!, /Market data was unavailable/);
    assert.equal(room.state.winner, null); assert.equal(room.state.fills.length, 0);
  } finally { await h.close(); }
});

test('an unavailable shared deadline snapshot prevents settlement and records a void round', { timeout: 12_000 }, async () => {
  const h = await harness({ countdownMs: 1_000, roundMs: 1_000 });
  try {
    const { room } = await readyCouch(h.manager);
    const original = h.feed.quotes.bind(h.feed);
    let settled = false;
    h.manager.ledger.settle = async () => { settled = true; return { accounts: [blankAccount(), blankAccount()], winner: null }; };
    h.feed.quotes = (asOf = Date.now()) => asOf >= room.state.endAt ? null : original(asOf);
    await waitUntil(() => room.state.phase === 'void');
    assert.match(room.state.reason!, /No fresh shared market snapshot/);
    assert.equal(settled, false); assert.equal(room.state.winner, null);
  } finally { await h.close(); }
});

test('provider clock correction recovers new quotes without clamping backward timestamps or restamping old observations', async context => {
  const base = 1_700_000_000_000;
  let now = base + 5_500;
  let date = new Date(base).toUTCString();
  context.mock.method(Date, 'now', () => now);
  context.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify([{ universe: COINS.map(name => ({ name })) }, COINS.map(() => ({ markPx: '100', prevDayPx: '99', dayNtlVlm: '1000' }))]), { headers: { date } }));
  const feed = new HyperliquidFeed(true);
  const transport = feed as unknown as { loadMetadata(): Promise<void>; consume(message: unknown): void };
  const books = (time: number) => { for (const coin of COINS) transport.consume({ channel: 'l2Book', data: { coin, time, levels: [[{ px: '99.99', sz: '1' }], [{ px: '100.01', sz: '1' }]] } }); };
  await transport.loadMetadata();
  books(base + 400);
  const initial = feed.quotes(); assert.ok(initial); assert.equal(feed.clock.offsetMs, 4_500);
  assert.ok(feed.snapshot().every(m => m.available));
  // Simulate the OS correcting a five-second lead. With the old offset, new
  // raw quotes would appear to be in the future and used to freeze the feed.
  now = base + 500;
  books(base + 450);
  assert.equal(feed.quotes(), null);
  await transport.loadMetadata();
  assert.equal(feed.clock.offsetMs, -500);
  books(base + 450);
  assert.equal(feed.quotes(), null, 'a backward correction must be held, never raised to the last timestamp');
  assert.deepEqual(feed.quotes(base + 5_500), initial, 'old accepted observations must retain their original timestamps');
  now = base + 6_500;
  date = new Date(base + 6_000).toUTCString();
  for (const coin of COINS) transport.consume({ channel: 'activeAssetCtx', data: { coin, ctx: { markPx: '101', prevDayPx: '99', dayNtlVlm: '1001' } } });
  books(base + 6_400);
  const recovered = feed.quotes(); assert.ok(recovered);
  assert.ok(recovered.every((quote, index) => quote.time > initial[index].time && quote.time <= now));
  assert.ok(feed.snapshot().every(m => m.available));
  // Rechecking HTTPS time alone cannot freshen the last received book.
  const acceptedTimes = recovered.map(x => x.time);
  now += 6_000; date = new Date(base + 12_000).toUTCString();
  await transport.loadMetadata();
  assert.deepEqual(feed.snapshot().map(m => m.time), acceptedTimes);
  assert.equal(feed.quotes(), null, 'stale books remain stale after a successful clock recheck');
});


test('candle streams keep each coin and interval independent, replace duplicates, and reject misrouted data', () => {
  const feed = new HyperliquidFeed();
  const transport = feed as unknown as { consume(message: unknown): void };
  const raw = (coin: string, interval: string, minute: number, value: number) => ({ s: coin, i: interval, t: minute * 60_000, o: String(value), h: String(value + 2), l: String(value - 2), c: String(value + 1), v: '7' });
  transport.consume({ channel: 'candle', data: [raw('BTC', '1m', 100, 100), raw('ETH', '1m', 100, 200), raw('BTC', '15m', 90, 300)] });
  const before = feed.snapshot();
  const btc = before.find(m => m.coin === 'BTC')!, eth = before.find(m => m.coin === 'ETH')!;
  assert.equal(btc.candles[0].close, 101); assert.equal(eth.candles[0].close, 201);
  assert.equal(btc.candleSets!['15m']![0].close, 301);
  assert.notStrictEqual(btc.candles, eth.candles);
  assert.notStrictEqual(btc.candles, btc.candleSets!['15m']);
  assert.strictEqual(btc.candles, btc.candleSets!['1m']);
  transport.consume({ channel: 'candle', data: [raw('BTC', '1m', 100, 120), raw('BTC', '1m', 101, 130), raw('BTC', '3m', 100, 900), raw('LTC', '1m', 100, 900), { ...raw('BTC', '1m', 102, 130), h: '1' }] });
  const after = feed.snapshot(), nextBtc = after.find(m => m.coin === 'BTC')!;
  assert.deepEqual(nextBtc.candles.map(c => c.close), [121, 131]);
  assert.deepEqual(after.find(m => m.coin === 'ETH')!.candles, eth.candles);
  assert.deepEqual(nextBtc.candleSets!['15m'], btc.candleSets!['15m']);
  assert.deepEqual(btc.candles.map(c => c.close), [101], 'an older snapshot must retain its own candle array');
  assert.equal(nextBtc.candleSets!['5m']!.length, 0);
});

test('native candle histories request all 18 coin/interval pairs with bounded concurrency and retain full 15m history', async context => {
  const intervals = ['1m', '5m', '15m'] as const;
  const seconds = { '1m': 60, '5m': 300, '15m': 900 };
  const requests: string[] = [];
  let inflight = 0, maxInflight = 0;
  context.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.type, 'candleSnapshot');
    const { coin, interval, startTime, endTime } = body.req;
    requests.push(`${coin}:${interval}`);
    assert.equal(endTime - startTime, 180 * seconds[interval as keyof typeof seconds] * 1000);
    inflight++; maxInflight = Math.max(maxInflight, inflight);
    await new Promise(resolve => setTimeout(resolve, 5));
    inflight--;
    const step = seconds[interval as keyof typeof seconds];
    const first = Math.floor(endTime / (step * 1000)) * step - 179 * step;
    const base = 100 + COINS.indexOf(coin) * 1000 + intervals.indexOf(interval) * 10;
    const candles = Array.from({ length: 180 }, (_, index) => ({ s: coin, i: interval, t: (first + index * step) * 1000, o: String(base + index), h: String(base + index + 2), l: String(base + index - 2), c: String(base + index + 1), v: '4' }));
    // A bad provider entry must not poison a different coin or timeframe.
    candles.push({ ...candles[0], s: 'LTC', c: '99999' });
    return new Response(JSON.stringify(candles), { headers: { date: new Date().toUTCString() } });
  });
  const feed = new HyperliquidFeed();
  await (feed as unknown as { loadCandles(): Promise<void> }).loadCandles();
  assert.equal(requests.length, 18); assert.equal(new Set(requests).size, 18); assert.equal(maxInflight, 2);
  const series = feed.snapshot();
  for (const market of series) for (const interval of intervals) {
    const candles = market.candleSets![interval]!;
    assert.equal(candles.length, 180, `${market.coin} ${interval}`);
    assert.equal(candles[1].time - candles[0].time, seconds[interval]);
    assert.equal(candles.at(-1)!.time - candles[0].time, 179 * seconds[interval]);
    assert.ok(candles.every(candle => candle.close < 99999));
  }
  assert.notStrictEqual(series[0].candleSets!['15m'], series[1].candleSets!['15m']);
  assert.strictEqual(series[0].candles, series[0].candleSets!['1m']);
});

test('live chart marks stay coin-specific and keep only actual latest receipts within each second', context => {
  const base = 1_700_000_000_000;
  let now = base + 100;
  context.mock.method(Date, 'now', () => now);
  const feed = new HyperliquidFeed();
  const transport = feed as unknown as { consume(message: unknown): void };
  const mark = (coin: string, value: string) => transport.consume({ channel: 'activeAssetCtx', data: { coin, ctx: { markPx: value, prevDayPx: '99', dayNtlVlm: '1000' } } });
  mark('BTC', '100'); mark('ETH', '200');
  const original = feed.snapshot();
  assert.deepEqual(original[0].priceHistory, [{ time: now / 1000, value: 100 }]);
  assert.deepEqual(original[1].priceHistory, [{ time: now / 1000, value: 200 }]);
  now = base + 800; mark('BTC', '101'); mark('BTC', '102');
  assert.deepEqual(feed.snapshot()[0].priceHistory, [{ time: now / 1000, value: 102 }]);
  assert.deepEqual(original[0].priceHistory, [{ time: (base + 100) / 1000, value: 100 }], 'older snapshots must not be rewritten by a same-second replacement');
  now = base + 50; mark('BTC', '105');
  assert.deepEqual(feed.snapshot(base + 800)[0].priceHistory, [{ time: (base + 800) / 1000, value: 102 }], 'a backward clock correction cannot fabricate a later price timestamp');
  now = base + 1100; mark('BTC', '103');
  for (const invalid of ['NaN', 'Infinity', '-1', '0']) mark('BTC', invalid);
  const next = feed.snapshot();
  assert.deepEqual(next[0].priceHistory, [{ time: (base + 800) / 1000, value: 102 }, { time: now / 1000, value: 103 }]);
  assert.deepEqual(next[1].priceHistory, original[1].priceHistory);
  next[0].priceHistory![0].value = 999;
  assert.equal(feed.snapshot()[0].priceHistory![0].value, 102, 'public snapshot objects must not mutate the stored chart observations');
  assert.ok(feed.snapshot()[2].priceHistory!.length === 0, 'another coin must not inherit BTC samples');
});

test('live chart history retains only the last fifteen minutes without inserting gap prices', context => {
  const base = 1_700_000_000_000;
  let now = base;
  context.mock.method(Date, 'now', () => now);
  const feed = new HyperliquidFeed();
  const transport = feed as unknown as { consume(message: unknown): void };
  for (let second = 0; second <= 920; second++) {
    now = base + second * 1000 + 100;
    transport.consume({ channel: 'activeAssetCtx', data: { coin: 'BTC', ctx: { markPx: String(100 + second), prevDayPx: '99', dayNtlVlm: '1000' } } });
  }
  const history = feed.snapshot()[0].priceHistory!;
  assert.equal(history.length, 901);
  assert.equal(history[0].time, (base + 20_100) / 1000);
  assert.equal(history.at(-1)!.time, now / 1000);
  now += 10_000;
  const later = feed.snapshot()[0].priceHistory!;
  assert.equal(later.at(-1)!.time, history.at(-1)!.time, 'reading snapshots must not refresh the last observed price');
  assert.equal(later.length, 891, 'the observation gap must stay empty');
  now += 901_000;
  assert.deepEqual(feed.snapshot()[0].priceHistory, []);
});

test('fresh chart marks cannot freshen stale execution books or historical quote timestamps', async context => {
  const base = 1_700_000_000_000;
  let now = base + 500;
  context.mock.method(Date, 'now', () => now);
  context.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify([{ universe: COINS.map(name => ({ name })) }, COINS.map(() => ({ markPx: '100', prevDayPx: '99', dayNtlVlm: '1000' }))]), { headers: { date: new Date(base).toUTCString() } }));
  const feed = new HyperliquidFeed(true);
  const transport = feed as unknown as { loadMetadata(): Promise<void>; consume(message: unknown): void };
  await transport.loadMetadata();
  for (const coin of COINS) transport.consume({ channel: 'l2Book', data: { coin, time: now, levels: [[{ px: '99.99', sz: '1' }], [{ px: '100.01', sz: '1' }]] } });
  const accepted = feed.quotes(); assert.ok(accepted);
  const acceptedTimes = feed.snapshot().map(market => market.time);
  now += 6500;
  for (const coin of COINS) transport.consume({ channel: 'activeAssetCtx', data: { coin, ctx: { markPx: '101', prevDayPx: '99', dayNtlVlm: '1001' } } });
  const snapshot = feed.snapshot();
  assert.ok(snapshot.every(market => market.priceHistory!.at(-1)!.time === now / 1000 && market.priceHistory!.at(-1)!.value === 101));
  assert.deepEqual(snapshot.map(market => market.time), acceptedTimes);
  assert.ok(snapshot.every(market => !market.available));
  assert.equal(feed.quotes(), null);
  assert.deepEqual(feed.quotes(base + 500), accepted, 'earlier deadline observations must retain their original values and timestamps');
});
