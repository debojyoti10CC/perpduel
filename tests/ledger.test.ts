import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import ganache from 'ganache';
import { BrowserProvider, Contract, id as hashId, parseUnits } from 'ethers';
import { createLedger, type Ledger } from '../server/ledger.ts';
import { compileContract } from '../server/compile.ts';
import { COINS, type Quote } from '../shared/types.ts';

let raw: ReturnType<typeof ganache.provider>;
let ledger: Ledger;
let counter = 0;
const usd = (n: number) => parseUnits(n.toFixed(8), 8);
async function now() { const b = await raw.request({ method: 'eth_getBlockByNumber', params: ['latest', false] }) as any; return Number(BigInt(b.timestamp)) * 1000; }
async function quotes(mark = 100, spread = 0): Promise<Quote[]> { const time = await now(); return COINS.map(coin => ({ coin, mark, bid: mark - spread, ask: mark + spread, time })); }
async function advance(seconds: number) { await raw.request({ method: 'evm_increaseTime', params: [seconds] }); await raw.request({ method: 'evm_mine', params: [] }); }
async function match() { const id = `test-${++counter}`; const start = await now() + 2000; const end = start + 60000; await ledger.create(id, start, end); await advance(2); return { id, start, end }; }
const near = (actual: number, expected: number, tolerance = 0.00001) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} should equal ${expected}`);

before(async () => {
  // Accounting cases advance their own clock explicitly. CPU scheduling must
  // not age a deterministic quote while the VM estimates and executes it.
  raw = ganache.provider({ logging: { quiet: true }, wallet: { totalAccounts: 3 }, chain: { chainId: 31337, hardfork: 'shanghai' }, miner: { instamine: 'eager', timestampIncrement: 0 } });
  ledger = await createLedger({ localProvider: raw as any });
});
after(async () => { await ledger?.close(); });

test('uses a real deployed contract and starts two independent $1,000 accounts', async () => {
  assert.equal(ledger.info.mode, 'local-evm');
  const code = await raw.request({ method: 'eth_getCode', params: [ledger.info.contractAddress, 'latest'] });
  assert.notEqual(code, '0x');
  const { id } = await match(); const s = await ledger.read(id);
  for (const a of s.accounts) { near(a.cash, 1000); near(a.equity, 1000); near(a.availableMargin, 1000); assert.equal(a.positions.length, 0); }
});

test('long fills at ask plus 1bp and charges 5bp of executed notional', async () => {
  const { id } = await match(); const r = await ledger.trade(id, 0, 0, 'long', 100, 1, await quotes(100, 0.05));
  assert.ok(r.txHash.startsWith('0x')); assert.ok(r.fill);
  const expectedPrice = 100.05 * 1.0001;
  near(r.fill.price, expectedPrice); near(r.fill.quantity, 300 / expectedPrice);
  near(r.fill.fee, 0.15);
  const a = r.snapshot.accounts[0]; near(a.fees, 0.15); near(a.reservedMargin, 100);
  near(a.equity, 1000 - 0.15 + r.fill.quantity * (100 - expectedPrice));
  near(r.snapshot.accounts[1].equity, 1000);
});

test('short uses bid minus slippage and wins when mark drops', async () => {
  const { id } = await match(); const r = await ledger.trade(id, 1, 2, 'short', 250, 1, await quotes(100));
  assert.ok(r.fill); near(r.fill.price, 99.99); assert.ok(r.fill.quantity < 0);
  const updated = await ledger.update(id, await quotes(95));
  assert.ok(updated.accounts[1].unrealizedPnl > 37); assert.ok(updated.accounts[1].equity > 1037);
});

test('net exposure increases with weighted entry and reserves margin across all markets', async () => {
  const { id } = await match();
  await ledger.trade(id, 0, 0, 'long', 100, 1, await quotes(100));
  await ledger.trade(id, 0, 0, 'long', 100, 2, await quotes(110));
  const r = await ledger.trade(id, 0, 1, 'short', 250, 3, await quotes(110));
  const a = r.snapshot.accounts[0]; near(a.reservedMargin, 450); assert.equal(a.positions.length, 2);
  const p = a.positions.find(p => p.coin === 'BTC')!; assert.ok(p.entry > 100 && p.entry < 110.02);
  assert.ok(p.quantity > 5.7); assert.equal(a.nonce, 3);
});

test('availability includes costs and prevents overspending the shared account', async () => {
  const { id } = await match();
  await ledger.trade(id, 0, 0, 'long', 500, 1, await quotes());
  await assert.rejects(ledger.trade(id, 0, 1, 'long', 500, 2, await quotes()), /margin/i);
  const a = (await ledger.read(id)).accounts[0]; assert.equal(a.positions.length, 1); assert.equal(a.nonce, 1);
});

test('partial close releases proportional margin; full close clears the position', async () => {
  const { id } = await match(); await ledger.trade(id, 0, 0, 'long', 250, 1, await quotes());
  const half = await ledger.trade(id, 0, 0, 'half', 100, 2, await quotes(101));
  near(half.snapshot.accounts[0].reservedMargin, 125);
  assert.ok(half.snapshot.accounts[0].realizedPnl > 3.6);
  const full = await ledger.trade(id, 0, 0, 'close', 100, 3, await quotes(101));
  assert.equal(full.snapshot.accounts[0].positions.length, 0); near(full.snapshot.accounts[0].reservedMargin, 0);
  near(full.snapshot.accounts[0].cash, 1000 + full.snapshot.accounts[0].realizedPnl - full.snapshot.accounts[0].fees);
});

test('reversal closes old exposure then opens the opposite net position', async () => {
  const { id } = await match(); await ledger.trade(id, 0, 0, 'long', 250, 1, await quotes());
  const r = await ledger.trade(id, 0, 0, 'short', 100, 2, await quotes(102));
  const a = r.snapshot.accounts[0]; assert.equal(a.positions.length, 1); assert.ok(a.positions[0].quantity < 0);
  near(a.reservedMargin, 100); assert.ok(a.realizedPnl > 14); assert.ok(a.fees > 0.9);
  assert.deepEqual(r.fills?.map(fill => fill.action), ['close', 'short']);
  assert.ok(r.fills!.every(fill => fill.fee > 0));
});

test('stale, out-of-order and missing data never produce a fill', async () => {
  const { id } = await match(); const fresh = await quotes();
  await ledger.update(id, fresh);
  await assert.rejects(ledger.trade(id, 0, 0, 'long', 100, 1, fresh.map(q => ({ ...q, time: q.time - 6000 }))), /quote|seconds|order/i);
  await assert.rejects(ledger.trade(id, 0, 0, 'long', 100, 1, fresh.map(q => ({ ...q, time: q.time + 10000 }))), /quote|seconds|order/i);
  await assert.rejects(ledger.trade(id, 0, 0, 'long', 100, 1, fresh.slice(1)), /quote|six/i);
  const before = await ledger.read(id); near(before.accounts[0].fees, 0); assert.equal(before.accounts[0].nonce, 0);
});

test('replayed/non-sequential action nonce is rejected', async () => {
  const { id } = await match(); await ledger.trade(id, 0, 0, 'long', 100, 1, await quotes());
  await assert.rejects(ledger.trade(id, 0, 0, 'long', 100, 1, await quotes()), /already|order|nonce/i);
  await assert.rejects(ledger.trade(id, 0, 0, 'long', 100, 3, await quotes()), /already|order|nonce/i);
  near((await ledger.read(id)).accounts[0].reservedMargin, 100);
});

test('maximum drawdown tracks peak-to-trough loss, including costs', async () => {
  const { id } = await match(); await ledger.trade(id, 0, 0, 'long', 100, 1, await quotes());
  const peak = await ledger.update(id, await quotes(110));
  const trough = await ledger.update(id, await quotes(90));
  const a = trough.accounts[0]; near(a.peakEquity, peak.accounts[0].equity);
  near(a.maxDrawdown, a.peakEquity - a.equity); near(a.score, a.equity - 1000 - 0.35 * a.maxDrawdown);
});

test('risk floor closes every market, disables seat, and preserves the opponent', async () => {
  const { id } = await match(); await ledger.trade(id, 0, 0, 'long', 500, 1, await quotes());
  const crashed = await ledger.update(id, await quotes(40)); const a = crashed.accounts[0];
  assert.equal(a.disabled, true); assert.equal(a.positions.length, 0); assert.ok(a.equity < 200); near(a.reservedMargin, 0);
  near(crashed.accounts[1].equity, 1000);
  await assert.rejects(ledger.trade(id, 0, 1, 'long', 100, 2, await quotes(40)), /risk floor|disabled/i);
});

test('a rejected order cannot roll back the opponent’s committed risk closure', async () => {
  const { id } = await match();
  await ledger.trade(id, 0, 0, 'long', 500, 1, await quotes());
  // Seat one has nothing to close, but the new shared price triggers seat zero's risk floor.
  await assert.rejects(ledger.trade(id, 1, 1, 'close', 100, 1, await quotes(40)), /position/i);
  const state = await ledger.read(id);
  assert.equal(state.accounts[0].disabled, true); assert.equal(state.accounts[0].positions.length, 0);
  assert.equal(state.accounts[1].nonce, 0); near(state.accounts[1].fees, 0);
});

test('a trade-triggered risk closure returns confirmed state without opening a new position', async () => {
  const { id } = await match();
  await ledger.trade(id, 0, 0, 'long', 500, 1, await quotes());
  const result = await ledger.trade(id, 0, 1, 'short', 100, 2, await quotes(40));
  assert.equal(result.fill, undefined); assert.equal(result.snapshot.accounts[0].disabled, true);
  assert.equal(result.snapshot.accounts[0].positions.length, 0); assert.equal(result.snapshot.accounts[0].nonce, 1);
  assert.equal((await ledger.receipt(result.txHash))?.status, 1);
});

test('trades during countdown are rejected without consuming action nonce', async () => {
  const id = `future-${++counter}`; const t = await now(); await ledger.create(id, t + 10000, t + 70000);
  await assert.rejects(ledger.trade(id, 0, 0, 'long', 100, 1, await quotes()), /window|active/i);
  assert.equal((await ledger.read(id)).accounts[0].nonce, 0);
});

test('only authorized relayer may mutate financial state', async () => {
  const provider = new BrowserProvider(raw as any); const other = new Contract(ledger.info.contractAddress, compileContract().abi, await provider.getSigner(1));
  const id = `unauthorized-${++counter}`; const t = await now();
  await assert.rejects(other.create(hashId(id), t / 1000, t / 1000 + 60)); provider.destroy();
});

test('deadline settlement closes both accounts using the SAME frozen quote and reads winner onchain', async () => {
  const { id, end } = await match();
  await ledger.trade(id, 0, 0, 'long', 100, 1, await quotes());
  await ledger.trade(id, 1, 0, 'short', 100, 1, await quotes());
  await advance(60);
  const frozen = (await quotes(105)).map(q => ({ ...q, time: end }));
  const r = await ledger.settle(id, frozen);
  assert.equal(r.winner, 0); assert.equal(r.accounts[0].positions.length, 0); assert.equal(r.accounts[1].positions.length, 0);
  assert.ok(r.accounts[0].equity > 1014); assert.ok(r.accounts[1].equity < 985);
  await assert.rejects(ledger.trade(id, 0, 0, 'long', 100, 2, frozen), /window|active/i);
  await assert.rejects(ledger.settle(id, frozen), /not open|match/i);
});

test('stale deadline snapshot cannot settle; voided matches never award a winner', async () => {
  const { id, end } = await match(); await advance(60);
  const stale = (await quotes()).map(q => ({ ...q, time: end - 6000 }));
  await assert.rejects(ledger.settle(id, stale), /quote|seconds/i);
  await ledger.void(id, 'feed outage'); assert.equal((await ledger.read(id)).winner, null);
  await assert.rejects(ledger.trade(id, 0, 0, 'long', 100, 1, await quotes()), /window|active/i);
});

test('a fresh rematch starts clean and an untouched round settles as a draw', async () => {
  const { id, end } = await match(); near((await ledger.read(id)).accounts[0].equity, 1000);
  await advance(60); const r = await ledger.settle(id, (await quotes()).map(q => ({ ...q, time: end })));
  assert.equal(r.winner, null); for (const a of r.accounts) { near(a.equity, 1000); near(a.score, 0); near(a.maxDrawdown, 0); }
});

test('global writer serialization confirms concurrent matches and returns actual EVM receipts', async () => {
  const one = await match(), two = await match(); const feed = await quotes();
  const [a, b] = await Promise.all([
    ledger.trade(one.id, 0, 0, 'long', 100, 1, feed),
    ledger.trade(two.id, 1, 1, 'short', 100, 1, feed),
  ]);
  assert.notEqual(a.txHash, b.txHash);
  assert.equal(a.snapshot.accounts[0].nonce, 1); assert.equal(b.snapshot.accounts[1].nonce, 1);
  const receipt = await ledger.receipt(a.txHash);
  assert.ok(receipt); assert.equal(receipt.status, 1); assert.ok(receipt.blockNumber > 0);
  assert.equal(receipt.contractAddress, ledger.info.contractAddress);
  assert.ok(receipt.events.some(e => e.name === 'Traded'));
  assert.equal(await ledger.receipt('invalid'), null);
});

test('real-time local ledger removes a retained clock offset without rewinding blocks or freshening quotes', { timeout: 20_000 }, async () => {
  const clockRaw = ganache.provider({ logging: { quiet: true }, wallet: { totalAccounts: 1 }, chain: { chainId: 31337, hardfork: 'shanghai', time: new Date(Date.now() + 4500) }, miner: { instamine: 'eager' } });
  const blockTime = async () => {
    const block = await clockRaw.request({ method: 'eth_getBlockByNumber', params: ['latest', false] }) as any;
    return Number(BigInt(block.timestamp)) * 1000;
  };
  let realTimeLedger: Ledger | undefined;
  try {
    // Initialize immediately so the configured offset survives provider startup.
    const initialBlockTime = await blockTime();
    assert.ok(initialBlockTime - Date.now() > 2500, 'the regression starts with a genuinely future local head');
    realTimeLedger = await createLedger({ localProvider: clockRaw as any, syncLocalClock: true });
    assert.ok(await blockTime() >= initialBlockTime, 'synchronization must not mine a block before its predecessor');
    assert.ok(Math.abs(await blockTime() - Date.now()) < 1100, 'the local head now follows the host clock');
    const start = (Math.floor(Date.now() / 1000) + 2) * 1000;
    await realTimeLedger.create('wall-clock-regression', start, start + 60_000);
    await new Promise(resolve => setTimeout(resolve, Math.max(0, start - Date.now() + 100)));
    const fresh = COINS.map(coin => ({ coin, mark: 100, bid: 99.99, ask: 100.01, time: Date.now() - 1700 }));
    await realTimeLedger.update('wall-clock-regression', fresh);
    const order = await realTimeLedger.trade('wall-clock-regression', 0, 0, 'long', 100, 1, fresh);
    assert.ok(order.fill); assert.equal(order.snapshot.accounts[0].nonce, 1);
    const stale = fresh.map(q => ({ ...q, time: Date.now() - 6500 }));
    await assert.rejects(realTimeLedger.update('wall-clock-regression', stale), /quote|seconds|order/i);
    assert.equal((await realTimeLedger.read('wall-clock-regression')).accounts[0].nonce, 1);
  } finally {
    if (realTimeLedger) await realTimeLedger.close();
    else await clockRaw.disconnect();
  }
});
