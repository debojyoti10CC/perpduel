import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';
import { startServer } from '../server/index.ts';
import { FixtureFeed } from '../server/markets.ts';
import type { ClientMessage, ServerMessage } from '../shared/types.ts';

async function connect(url: string) {
  const ws = new WebSocket(url);
  const messages: ServerMessage[] = [];
  ws.on('message', raw => messages.push(JSON.parse(raw.toString())));
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const waitFor = async <T extends ServerMessage>(predicate: (message: ServerMessage) => message is T, timeout = 15_000): Promise<T> => {
    const started = Date.now();
    while (Date.now() - started < timeout) { const found = messages.find(predicate); if (found) return found; await new Promise(resolve => setTimeout(resolve, 30)); }
    throw new Error(`Timed out awaiting server event. Recent state and feedback: ${JSON.stringify(messages.filter(x => x.type !== 'markets').slice(-3))}`);
  };
  return { ws, messages, waitFor, send(message: ClientMessage) { ws.send(JSON.stringify(message)); } };
}

test('real local EVM: two browsers ready, trade, recover, settle and save confirmed result', { timeout: 90_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'trading-duel-integration-'));
  const app = await startServer({ port: 0, host: '127.0.0.1', production: true, testMode: true, feed: new FixtureFeed(), roundMs: 30_000, countdownMs: 5_000, dataDir: dir });
  const clients: WebSocket[] = [];
  try {
    const a = await connect(`ws://127.0.0.1:${app.port}/ws`), b = await connect(`ws://127.0.0.1:${app.port}/ws`); clients.push(a.ws, b.ws);
    const oversized = await connect(`ws://127.0.0.1:${app.port}/ws`); clients.push(oversized.ws);
    const oversizeClosed = new Promise<number>(resolve => oversized.ws.once('close', code => resolve(code)));
    oversized.ws.send(' '.repeat(4_097));
    assert.equal(await oversizeClosed, 1009, 'oversized messages must be rejected at the transport boundary');
    a.send({ type: 'create', mode: 'online', name: 'Alpha' });
    const wa = await a.waitFor((m): m is Extract<ServerMessage, { type: 'welcome' }> => m.type === 'welcome');
    b.send({ type: 'join', code: wa.code, name: 'Beta' });
    const wb = await b.waitFor((m): m is Extract<ServerMessage, { type: 'welcome' }> => m.type === 'welcome');
    a.send({ type: 'action', seat: 1, id: 'unauthorized', action: 'long' });
    await a.waitFor((m): m is Extract<ServerMessage, { type: 'error' }> => m.type === 'error' && m.message.includes('belongs to another'));
    a.send({ type: 'action', seat: 0, id: 'ready-a', action: 'ready' }); b.send({ type: 'action', seat: 1, id: 'ready-b', action: 'ready' });
    const active = await a.waitFor((m): m is Extract<ServerMessage, { type: 'state' }> => m.type === 'state' && m.state.phase === 'active');
    assert.equal(active.state.ledger.mode, 'local-evm'); assert.equal(active.state.ledger.chainId, 31337);
    assert.match(active.state.txHash!, /^0x[0-9a-f]{64}$/i);
    const order: ClientMessage = { type: 'action', seat: 0, id: 'same-order', action: 'long' };
    a.send(order); a.send(order);
    const opened = await a.waitFor((m): m is Extract<ServerMessage, { type: 'state' }> => m.type === 'state' && m.state.players[0].nonce === 1);
    assert.equal(opened.state.players[0].positions.length, 1); assert.ok(opened.state.players[0].fees > 0);
    assert.equal(opened.state.fills.filter(x => x.seat === 0).length, 1);
    b.send({ type: 'action', seat: 1, id: 'short-b', action: 'short' });
    await b.waitFor((m): m is Extract<ServerMessage, { type: 'state' }> => m.type === 'state' && m.state.players[1].nonce === 1);
    b.ws.close(); await new Promise(resolve => setTimeout(resolve, 150));
    const recovered = await connect(`ws://127.0.0.1:${app.port}/ws`); clients.push(recovered.ws);
    recovered.send({ type: 'resume', code: wb.code, token: wb.token });
    const wr = await recovered.waitFor((m): m is Extract<ServerMessage, { type: 'welcome' }> => m.type === 'welcome'); assert.deepEqual(wr.seats, [1]);
    const finish = await a.waitFor((m): m is Extract<ServerMessage, { type: 'state' }> => m.type === 'state' && (m.state.phase === 'finished' || m.state.phase === 'void'), 40_000);
    assert.equal(finish.state.phase, 'finished', finish.state.reason);
    assert.ok(finish.state.players.every(x => x.positions.length === 0));
    assert.equal(finish.state.players[0].nonce, 1, 'duplicate order must not advance contract nonce twice');
    assert.ok(Math.abs(finish.state.players[0].score - (finish.state.players[0].equity - 1000 - .35 * finish.state.players[0].maxDrawdown)) < 1e-7);
    const history = await (await fetch(`http://127.0.0.1:${app.port}/api/history`)).json() as any;
    assert.equal(history.matches[0].id, finish.state.id); assert.equal(history.matches[0].phase, 'finished');
    assert.match(history.matches[0].txHash, /^0x[0-9a-f]{64}$/i);
    const receipt = await (await fetch(`http://127.0.0.1:${app.port}/api/receipt/${history.matches[0].txHash}`)).json() as any;
    assert.equal(receipt.status, 1); assert.ok(receipt.events.some((event: any) => event.name === 'Settled'));
    assert.ok(!JSON.stringify(history).includes(wb.token), 'saved records must not expose seat recovery secrets');
    a.send({ type: 'rematch' });
    const rematch = await a.waitFor((m): m is Extract<ServerMessage, { type: 'state' }> => m.type === 'state' && m.state.phase === 'lobby' && m.state.id !== finish.state.id);
    assert.ok(rematch.state.players.every(x => x.equity === 1000 && x.nonce === 0 && !x.ready));
  } finally {
    for (const ws of clients) ws.terminate();
    await app.close(); await rm(dir, { recursive: true, force: true });
  }
});
