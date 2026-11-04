import 'dotenv/config';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { createLedger } from './ledger.ts';
import { PaperLedger } from './paperLedger.ts';
import { FixtureFeed, HyperliquidFeed, type MarketFeed } from './markets.ts';
import { MatchManager, send } from './matches.ts';
import { randomBytes } from 'node:crypto';
import { getAddress, verifyMessage } from 'ethers';
import { DEFAULT_ROUND_SECONDS, ROUND_DURATIONS } from '../shared/types.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export interface ServerOptions { port?: number; host?: string; production?: boolean; listen?: boolean; testMode?: boolean; feed?: MarketFeed; roundMs?: number; countdownMs?: number; recoveryMs?: number; outageMs?: number; dataDir?: string }
const mimeTypes: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2' };
function json(response: ServerResponse, status: number, body: unknown): void { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(JSON.stringify(body)); }
const cookieToken = (request: IncomingMessage) => request.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith('perpduel_session='))?.slice('perpduel_session='.length);
function lanOrigin(request: IncomingMessage, address: AddressInfo | string | null): string | null {
  if (!/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(request.headers.host ?? '')) return null;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '')) return null;
  if (!address || typeof address === 'string' || !['0.0.0.0', '::'].includes(address.address)) return null;
  const adapters = Object.entries(networkInterfaces()).sort(([a], [b]) =>
    Number(/wi-?fi|wlan/i.test(b)) - Number(/wi-?fi|wlan/i.test(a)));
  for (const [name, entries] of adapters) {
    if (/virtual|vEthernet|loopback|tailscale|vpn/i.test(name)) continue;
    const ip = entries?.find(entry => entry.family === 'IPv4' && !entry.internal &&
      /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(entry.address));
    if (ip) return `http://${ip.address}:${address.port}`;
  }
  return null;
}
function sameOrigin(request: IncomingMessage): boolean {
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  if (!request.headers.origin) return true;
  try { return new URL(request.headers.origin).host === request.headers.host; } catch { return false; }
}
async function readJson(request: IncomingMessage): Promise<any> {
  if (!request.headers['content-type']?.toLowerCase().includes('application/json')) throw new Error('Send a JSON request.');
  let body = '';
  for await (const chunk of request) { body += chunk.toString(); if (Buffer.byteLength(body) > 4096) throw new Error('Request is too large.'); }
  try { return JSON.parse(body); } catch { throw new Error('Request must contain valid JSON.'); }
}

export async function startServer(options: ServerOptions = {}) {
  const production = options.production ?? process.argv.includes('--production');
  const testMode = options.testMode ?? process.env.TRADING_DUEL_TEST_MODE === '1';
  if (process.env.FEED_MODE === 'test' && !testMode) throw new Error('Test fixture data requires TRADING_DUEL_TEST_MODE=1. It is never enabled as a live-data fallback.');
  if (!testMode && (options.roundMs || options.countdownMs || process.env.ROUND_SECONDS || process.env.COUNTDOWN_SECONDS)) throw new Error('Custom match timing is restricted to explicit test mode');
  const ledger = !testMode && (process.env.LEDGER_MODE || 'paper') === 'paper'
    ? new PaperLedger()
    : await createLedger(testMode ? { mode: 'local-evm' } : {});
  const feed: MarketFeed = options.feed ?? (testMode && process.env.FEED_MODE === 'test' ? new FixtureFeed() : new HyperliquidFeed(ledger.info.mode !== 'monad'));
  if (feed.source === 'test-fixture' && !testMode) { await ledger.close(); throw new Error('Fixture feed requires explicit test mode'); }
  const roundMs = testMode ? options.roundMs ?? Number(process.env.ROUND_SECONDS || DEFAULT_ROUND_SECONDS) * 1000 : DEFAULT_ROUND_SECONDS * 1000;
  const matches = new MatchManager(ledger, feed, { roundMs, countdownMs: testMode ? options.countdownMs ?? Number(process.env.COUNTDOWN_SECONDS || 5) * 1000 : 5_000, recoveryMs: testMode ? options.recoveryMs ?? 20_000 : 20_000, outageMs: testMode ? options.outageMs ?? 20_000 : 20_000, dataDir: options.dataDir ?? path.resolve(ROOT, process.env.DATA_DIR || 'data') });
  await matches.start();
  const challenges = new Map<string, { nonce: string; message: string; address: string; expiresAt: number }>();
  void feed.start().catch(error => { console.error(`Market feed initialization failed: ${error.message}`); });
  const vite = production ? undefined : await (await import('vite')).createServer({ root: ROOT, server: { middlewareMode: true }, appType: 'spa' });
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', 'http://localhost');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
      if (request.method === 'POST' && url.pathname.startsWith('/api/') && !sameOrigin(request)) return json(response, 403, { error: 'Cross-origin mutations are not allowed.' });
      const sessionForRequest = async () => {
        const result = await matches.bank.session(cookieToken(request));
        if (result.token) {
          const secure = request.headers.origin?.startsWith('https:') || ('encrypted' in request.socket && request.socket.encrypted);
          response.setHeader('Set-Cookie', `perpduel_session=${result.token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${secure ? '; Secure' : ''}`);
        }
        return result;
      };
      if (url.pathname === '/api/session' && request.method === 'GET') return json(response, 200, (await sessionForRequest()).session);
      if (url.pathname === '/api/deposit' && request.method === 'POST') {
        try { const session = await sessionForRequest(); return json(response, 200, await matches.bank.deposit(session.accountId, await readJson(request))); }
        catch (error: any) { return json(response, 400, { error: error.message }); }
      }
      if (url.pathname === '/api/auth/challenge' && request.method === 'POST') {
        try {
          const session = await sessionForRequest();
          const body = await readJson(request);
          const address = getAddress(body.address);
          const nonce = randomBytes(24).toString('hex');
          const expiresAt = Date.now() + 5 * 60_000;
          const message = `PERPDUEL wallet sign-in\n\nAddress: ${address}\nHost: ${request.headers.host}\nChain ID: 10143 (Monad testnet)\nSession: ${session.accountId}\nNonce: ${nonce}\nIssued: ${new Date().toISOString()}\nExpires: ${new Date(expiresAt).toISOString()}\n\nThis signature signs you in. It does not transfer funds or approve token spending.`;
          for (const [id, challenge] of challenges) if (challenge.expiresAt < Date.now()) challenges.delete(id);
          challenges.set(session.accountId, { nonce, message, address, expiresAt });
          return json(response, 200, { message, nonce });
        } catch { return json(response, 400, { error: 'Enter a valid wallet address.' }); }
      }
      if (url.pathname === '/api/auth/verify' && request.method === 'POST') {
        try {
          const session = await sessionForRequest();
          const body = await readJson(request);
          const challenge = challenges.get(session.accountId);
          challenges.delete(session.accountId);
          if (!challenge || challenge.expiresAt <= Date.now() || getAddress(body.address) !== challenge.address || body.nonce !== undefined && body.nonce !== challenge.nonce || typeof body.signature !== 'string' || getAddress(verifyMessage(challenge.message, body.signature)) !== challenge.address) throw new Error('Invalid sign-in signature.');
          return json(response, 200, await matches.bank.bindWallet(session.accountId, challenge.address));
        } catch { return json(response, 401, { error: 'Wallet sign-in failed or expired. Request a new challenge and sign it.' }); }
      }
      if (url.pathname === '/api/escrow/config') {
        if (request.method === 'GET') return json(response, 200, matches.escrow.config());
        if (request.method === 'POST') {
          try {
            const session = await sessionForRequest();
            if (!session.session.walletAddress) return json(response, 401, { error: 'Sign in with the deploying wallet first.' });
            return json(response, 200, await matches.escrow.register(session.session.walletAddress, await readJson(request)));
          } catch (error: any) { return json(response, 400, { error: String(error.shortMessage || error.message).slice(0, 200) }); }
        }
      }
      if (url.pathname === '/api/rooms' && request.method === 'GET') return json(response, 200, { rooms: matches.getPublicRooms() });
      const fundingRoute = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9]{6})\/funding$/);
      if (fundingRoute && request.method === 'POST') {
        try { return json(response, 200, { state: await matches.syncFunding(fundingRoute[1]) }); }
        catch (error: any) { return json(response, 400, { error: String(error.shortMessage || error.message).slice(0, 200) }); }
      }
      const resultRoute = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9]{6})\/result$/);
      if (resultRoute && request.method === 'GET') {
        try { return json(response, 200, await matches.getResolution(resultRoute[1])); }
        catch (error: any) { return json(response, 400, { error: String(error.shortMessage || error.message).slice(0, 200) }); }
      }
      if (url.pathname === '/api/health') return json(response, 200, { ok: true, serverTime: Date.now(), source: feed.source, feedConnected: feed.connected, marketsReady: feed.snapshot().filter(x => x.available).length, feedError: feed.clock?.error ?? feed.lastError, clock: feed.clock, feedDiagnostics: feed.diagnostics, ledger: ledger.info, roundSeconds: Math.ceil(roundMs / 1000), roundDurations: ROUND_DURATIONS, testMode });
      if (url.pathname === '/api/invite-origin' && request.method === 'GET') return json(response, 200, { origin: lanOrigin(request, server.address()) });
      if (url.pathname === '/api/history') return json(response, 200, { matches: matches.getHistory() });
      if (url.pathname.startsWith('/api/receipt/')) {
        const hash = url.pathname.slice('/api/receipt/'.length);
        if (!/^0x[0-9a-f]{64}$/i.test(hash)) return json(response, 400, { error: 'Invalid transaction hash' });
        const receipt = await ledger.receipt(hash);
        return json(response, receipt ? 200 : 404, receipt ?? { error: 'No confirmed receipt for this PaperDuel contract' });
      }
      if (url.pathname.startsWith('/api/matches/')) {
        const record = matches.getRecord(url.pathname.slice('/api/matches/'.length));
        return json(response, record ? 200 : 404, record ?? { error: 'Match record not found' });
      }
      if (url.pathname === '/api/markets') return json(response, 200, { markets: feed.snapshot(), source: feed.source, connected: feed.connected, clock: feed.clock, serverTime: Date.now() });
      if (url.pathname.startsWith('/api/')) return json(response, 404, { error: 'API route not found' });
      if (vite) return vite.middlewares(request, response, () => { response.writeHead(404); response.end('Not found'); });
      if (request.method !== 'GET' && request.method !== 'HEAD') return json(response, 405, { error: 'Method not allowed' });
      const dist = path.join(ROOT, 'dist');
      const decoded = decodeURIComponent(url.pathname);
      let file = path.resolve(dist, `.${decoded}`);
      if (!file.startsWith(`${dist}${path.sep}`) && file !== dist) return json(response, 403, { error: 'Forbidden' });
      const info = await stat(file).catch(() => null);
      if (!info?.isFile()) {
        if (path.extname(file) && path.extname(file) !== '.html') return json(response, 404, { error: 'Asset not found' });
        file = path.join(dist, 'index.html');
      }
      const contents = await readFile(file);
      response.writeHead(200, { 'Content-Type': mimeTypes[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': path.basename(file) === 'index.html' ? 'no-cache' : 'public, max-age=3600' });
      response.end(request.method === 'HEAD' ? undefined : contents);
    } catch (error: any) { if (!response.headersSent) json(response, 500, { error: 'Unable to serve this request' }); else response.end(); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '/', 'http://localhost');
    if (url.pathname !== '/ws' && url.pathname !== '/api/ws') { socket.destroy(); return; }
    // Only same-origin browser connections; non-browser test clients may omit Origin.
    const origin = request.headers.origin;
    if (origin) {
      try { if (new URL(origin).host !== request.headers.host) { socket.destroy(); return; } } catch { socket.destroy(); return; }
    }
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
  });
  wss.on('connection', (ws, request) => {
    const peer = matches.add(ws, matches.bank.accountForToken(cookieToken(request)));
    let alive = true;
    ws.on('pong', () => { alive = true; });
    const heartbeat = setInterval(() => { if (!alive) return ws.terminate(); alive = false; ws.ping(); }, 15_000);
    ws.on('message', (data, binary) => {
      if (binary) return send(peer, { type: 'error', message: 'Binary messages are not supported' });
      let message: unknown;
      try { message = JSON.parse(data.toString()); } catch { send(peer, { type: 'error', message: 'Message must be valid JSON' }); return; }
      void matches.handle(peer, message).catch(error => send(peer, { type: 'error', message: String(error.message || 'Invalid request').slice(0, 220) }));
    });
    ws.on('close', () => { clearInterval(heartbeat); matches.detach(peer); });
    ws.on('error', () => { /* Close handler owns recovery; no process-level throw. */ });
  });
  const port = options.port ?? Number(process.env.PORT || 3000);
  const host = options.host ?? process.env.HOST ?? '0.0.0.0';
  let actualPort = port;
  if (options.listen !== false) {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(); }); });
    const address = server.address();
    actualPort = typeof address === 'object' && address ? address.port : port;
    console.log(`Trading Duel ready at http://localhost:${actualPort} (${feed.source}, ${ledger.info.mode})`);
  }
  let closing = false;
  async function close(): Promise<void> {
    if (closing) return; closing = true;
    feed.stop(); await matches.close();
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await vite?.close();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await ledger.close();
  }
  return { server, wss, matches, feed, ledger, port: actualPort, close };
}

const entry = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (entry) {
  startServer().then(app => {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close().then(() => process.exit(0)); });
  }).catch(error => { console.error(`Trading Duel could not start: ${error.message}`); process.exitCode = 1; });
}
