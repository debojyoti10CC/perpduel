import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ContractFactory, JsonRpcProvider, Wallet, ZeroAddress, parseEther } from 'ethers';
import ganache from 'ganache';
import WebSocket from 'ws';
import { DemoBank, validateStake } from '../server/demoBank.ts';
import { startServer } from '../server/index.ts';
import { FixtureFeed } from '../server/markets.ts';
import type { ClientMessage, ServerMessage } from '../shared/types.ts';
import { compileEscrow } from '../scripts/compile-escrow.ts';

test('demo funds reserve in integer units, pay once, and refund pending reservations on restart', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'perpduel-bank-'));
  const bank = new DemoBank(dir);
  try {
    await bank.start();
    const a = await bank.session(), b = await bank.session();
    await bank.deposit(a.accountId, { asset: 'MON', amount: 0.3 });
    await bank.deposit(b.accountId, { asset: 'MON', amount: 0.3 });
    await bank.reserve('first', a.accountId, [0], { asset: 'MON', amount: 0.1 });
    await bank.reserve('first', b.accountId, [1], { asset: 'MON', amount: 0.1 });
    assert.equal(bank.snapshot(a.accountId).balances.MON, 0.2);
    assert.equal(bank.snapshot(a.accountId).reserved.MON, 0.1);
    await assert.rejects(() => bank.reserve('other', a.accountId, [0], { asset: 'MON', amount: 0.3 }), /Insufficient/);
    assert.equal(await bank.resolve('first', 0), 'paid');
    await bank.resolve('first', 0);
    assert.equal(bank.snapshot(a.accountId).balances.MON, 0.4);
    assert.equal(bank.snapshot(b.accountId).balances.MON, 0.2);
    await bank.reserve('draw', a.accountId, [0, 1], { asset: 'MON', amount: 0.1 });
    await bank.resolve('draw', null);
    assert.equal(bank.snapshot(a.accountId).balances.MON, 0.4);
    await bank.reserve('interrupted', a.accountId, [0], { asset: 'MON', amount: 0.1 });
    await bank.close();
    const restarted = new DemoBank(dir); await restarted.start();
    assert.equal(restarted.accountForToken(a.token), a.accountId);
    assert.equal(restarted.snapshot(a.accountId).balances.MON, 0.4);
    assert.equal(restarted.snapshot(a.accountId).reserved.MON, 0);
    await restarted.close();
  } finally { await bank.close(); await rm(dir, { recursive: true, force: true }); }
});

test('stake validation rejects coercion, precision loss, and invalid assets', () => {
  for (const amount of [0, -1, NaN, Infinity, 0.0000001, 1_000_001, '1']) assert.throws(() => validateStake({ asset: 'MON', amount }));
  assert.throws(() => validateStake({ asset: 'BTC', amount: 1 }));
  assert.deepEqual(validateStake({ asset: 'SOL', amount: 0.000001 }), { asset: 'SOL', amount: 0.000001 });
});

async function connect(url: string, cookie: string) {
  const socket = new WebSocket(url, { headers: { Cookie: cookie } });
  const messages: ServerMessage[] = [];
  socket.on('message', raw => messages.push(JSON.parse(raw.toString())));
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  return { socket, messages, send(value: ClientMessage) { socket.send(JSON.stringify(value)); }, async wait(predicate: (value: ServerMessage) => boolean, timeout = 10_000) {
    const started = Date.now();
    while (Date.now() - started < timeout) { const found = messages.find(predicate); if (found) return found; await new Promise(resolve => setTimeout(resolve, 20)); }
    throw new Error('Expected room event was not received.');
  } };
}

test('two cookie sessions authenticate, create/join actual server rooms, reserve demo stakes, and cancel safely', { timeout: 45_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'perpduel-http-'));
  const app = await startServer({ port: 0, host: '127.0.0.1', production: true, testMode: true, feed: new FixtureFeed(), dataDir: dir });
  const origin = `http://127.0.0.1:${app.port}`;
  const clients: WebSocket[] = [];
  try {
    const first = await fetch(`${origin}/api/session`), second = await fetch(`${origin}/api/session`);
    const cookieA = first.headers.get('set-cookie')!.split(';')[0], cookieB = second.headers.get('set-cookie')!.split(';')[0];
    assert.match(first.headers.get('set-cookie')!, /HttpOnly; SameSite=Lax/);
    const accountA = await first.json() as any, accountB = await second.json() as any;
    assert.notEqual(accountA.accountId, accountB.accountId);
    const post = (route: string, cookie: string, body: unknown, requestOrigin = origin) => fetch(`${origin}${route}`, { method: 'POST', headers: { Cookie: cookie, Origin: requestOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post('/api/deposit', cookieA, { asset: 'MON', amount: 10 }, 'https://attacker.invalid')).status, 403);
    assert.equal((await post('/api/deposit', cookieA, { asset: 'MON', amount: '10' })).status, 400);
    const signer = Wallet.createRandom();
    const challenge = await (await post('/api/auth/challenge', cookieA, { address: signer.address })).json() as any;
    const signature = await signer.signMessage(challenge.message);
    const authenticated = await post('/api/auth/verify', cookieA, { address: signer.address, signature });
    assert.equal(authenticated.status, 200);
    assert.equal((await authenticated.json() as any).walletAddress, signer.address);
    assert.equal((await post('/api/auth/verify', cookieA, { address: signer.address, signature })).status, 401, 'sign-in challenges are single-use');
    for (const cookie of [cookieA, cookieB]) assert.equal((await post('/api/deposit', cookie, { asset: 'MON', amount: 10 })).status, 200);
    const a = await connect(`${origin.replace('http', 'ws')}/ws`, cookieA), b = await connect(`${origin.replace('http', 'ws')}/ws`, cookieB);
    clients.push(a.socket, b.socket);
    a.send({ type: 'create', mode: 'online', name: 'Alpha', stake: { asset: 'MON', amount: 3 }, fundingMode: 'demo' });
    const welcome = await a.wait(value => value.type === 'welcome'); assert.equal(welcome.type, 'welcome'); if (welcome.type !== 'welcome') return;
    const publicRooms = await (await fetch(`${origin}/api/rooms`)).json() as any;
    assert.equal(publicRooms.rooms[0].code, welcome.code);
    assert.deepEqual(publicRooms.rooms[0].stake, { asset: 'MON', amount: 3 });
    b.send({ type: 'join', code: welcome.code, name: 'Beta' });
    await b.wait(value => value.type === 'welcome');
    const getBalance = async (cookie: string) => (await (await fetch(`${origin}/api/session`, { headers: { Cookie: cookie } })).json() as any);
    assert.equal((await getBalance(cookieA)).balances.MON, 7);
    assert.equal((await getBalance(cookieB)).reserved.MON, 3);
    a.send({ type: 'action', id: 'steal-seat', seat: 1, action: 'long' });
    await a.wait(value => value.type === 'error' && value.message.includes('belongs to another'));
    a.send({ type: 'leave' }); await a.wait(value => value.type === 'left');
    assert.equal((await getBalance(cookieA)).balances.MON, 10);
    assert.equal((await getBalance(cookieB)).balances.MON, 10);
    assert.equal((await (await fetch(`${origin}/api/rooms`)).json() as any).rooms.length, 0);
    b.send({ type: 'create', mode: 'online', name: 'Needs escrow', fundingMode: 'monad-testnet', stake: { asset: 'MON', amount: 1 } });
    await b.wait(value => value.type === 'error' && /sign in|configured|Deploy/i.test(value.message));
    assert.equal((await getBalance(cookieB)).balances.MON, 10, 'unconfigured real funding never debits demo balances');
  } finally {
    clients.forEach(socket => socket.terminate()); await app.close(); await rm(dir, { recursive: true, force: true });
  }
});

test('Monad-chain escrow provenance, two signed wallets, funding gate and server-attested refund work together', { timeout: 90_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'perpduel-monad-integration-'));
  const chain = ganache.server({ logging: { quiet: true }, chain: { chainId: 10143, hardfork: 'shanghai' }, wallet: { totalAccounts: 3 }, miner: { instamine: 'eager' } });
  await chain.listen(0, '127.0.0.1');
  const address = chain.address(); assert.ok(address && typeof address !== 'string');
  const rpc = `http://127.0.0.1:${address.port}`;
  const previousRpc = process.env.ESCROW_RPC_URL;
  process.env.ESCROW_RPC_URL = rpc;
  const provider = new JsonRpcProvider(rpc); provider.pollingInterval = 20;
  const app = await startServer({ port: 0, host: '127.0.0.1', production: true, testMode: true, feed: new FixtureFeed(), dataDir: dir, roundMs: 10_000, countdownMs: 1_000 });
  const origin = `http://127.0.0.1:${app.port}`;
  const clients: WebSocket[] = [];
  try {
    const [host, guest] = await Promise.all([provider.getSigner(0), provider.getSigner(1)]);
    const initial = Object.values(chain.provider.getInitialAccounts());
    const hostAuth = new Wallet(initial[0].secretKey), guestAuth = new Wallet(initial[1].secretKey);
    const post = (route: string, cookie: string, body: unknown) => fetch(`${origin}${route}`, { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const login = async (wallet: Wallet) => {
      const response = await fetch(`${origin}/api/session`), cookie = response.headers.get('set-cookie')!.split(';')[0];
      const challenge = await (await post('/api/auth/challenge', cookie, { address: wallet.address })).json() as any;
      const verified = await post('/api/auth/verify', cookie, { address: wallet.address, signature: await wallet.signMessage(challenge.message) });
      assert.equal(verified.status, 200); return cookie;
    };
    const cookieA = await login(hostAuth), cookieB = await login(guestAuth);
    const config = await (await fetch(`${origin}/api/escrow/config`)).json() as any;
    assert.equal(config.configured, false);
    const artifact = compileEscrow();
    const escrow = await new ContractFactory(artifact.abi, artifact.bytecode, host).deploy(config.resultSigner) as any;
    await escrow.waitForDeployment();
    const registration = await post('/api/escrow/config', cookieA, { contractAddress: await escrow.getAddress(), transactionHash: escrow.deploymentTransaction().hash });
    assert.equal(registration.status, 200, await registration.text());
    const a = await connect(`${origin.replace('http', 'ws')}/ws`, cookieA), b = await connect(`${origin.replace('http', 'ws')}/ws`, cookieB);
    clients.push(a.socket, b.socket);
    a.send({ type: 'create', mode: 'online', name: 'Chain Alpha', stake: { asset: 'MON', amount: 0.1 }, fundingMode: 'monad-testnet' });
    const welcome = await a.wait(value => value.type === 'welcome'); assert.equal(welcome.type, 'welcome'); if (welcome.type !== 'welcome') return;
    const pending = await a.wait(value => value.type === 'state' && Boolean(value.state.funding)); assert.equal(pending.type, 'state'); if (pending.type !== 'state') return;
    const funding = pending.state.funding!;
    assert.equal((await (await fetch(`${origin}/api/rooms`)).json() as any).rooms.length, 0, 'unfunded rooms are not advertised');
    await (await escrow.createRoom(funding.roomId, funding.refundAfter, { value: parseEther('0.1') })).wait();
    const hostSync = await post(`/api/rooms/${welcome.code}/funding`, cookieA, {});
    assert.equal(hostSync.status, 200);
    assert.equal((await hostSync.json() as any).state.funding.status, 'open');
    assert.equal((await (await fetch(`${origin}/api/rooms`)).json() as any).rooms.length, 1);
    b.send({ type: 'join', code: welcome.code, name: 'Chain Beta' }); await b.wait(value => value.type === 'welcome');
    b.send({ type: 'action', id: 'too-early', seat: 1, action: 'ready' });
    await b.wait(value => value.type === 'feedback' && value.kind === 'reject' && value.message.includes('Both MON stakes'));
    await (await escrow.connect(guest).joinRoom(funding.roomId, { value: parseEther('0.1') })).wait();
    const allFunded = await post(`/api/rooms/${welcome.code}/funding`, cookieB, {});
    assert.equal((await allFunded.json() as any).state.funding.status, 'funded');
    a.send({ type: 'action', id: 'ready-a-chain', seat: 0, action: 'ready' });
    b.send({ type: 'action', id: 'ready-b-chain', seat: 1, action: 'ready' });
    await a.wait(value => value.type === 'state' && value.state.phase === 'active', 15_000);
    a.send({ type: 'leave' }); await a.wait(value => value.type === 'left');
    const response = await fetch(`${origin}/api/rooms/${welcome.code}/result`);
    assert.equal(response.status, 200);
    const voucher = await response.json() as any;
    assert.equal(voucher.winner, ZeroAddress, 'void rounds return both on-chain stakes');
    await (await escrow.connect(guest).resolve(voucher.roomId, voucher.winner, voucher.deadline, voucher.signature)).wait();
    assert.equal(await escrow.credits(hostAuth.address), parseEther('0.1'));
    assert.equal(await escrow.credits(guestAuth.address), parseEther('0.1'));
    await (await escrow.connect(guest).withdraw()).wait();
    assert.equal(await escrow.credits(guestAuth.address), 0n);
  } finally {
    clients.forEach(socket => socket.terminate()); await app.close(); provider.destroy(); await chain.close();
    if (previousRpc === undefined) delete process.env.ESCROW_RPC_URL; else process.env.ESCROW_RPC_URL = previousRpc;
    await rm(dir, { recursive: true, force: true });
  }
});
