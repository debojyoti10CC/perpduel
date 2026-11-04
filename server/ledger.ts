import 'dotenv/config';
import { BrowserProvider, Contract, ContractFactory, JsonRpcProvider, Wallet, id as hashId, parseUnits, type Eip1193Provider, type Signer, type TransactionReceipt } from 'ethers';
import { COINS, type Account, type LedgerInfo, type LedgerSnapshot, type Quote, type TradeAction } from '../shared/types.ts';
import { compileContract } from './compile.ts';

const USD = 1e8;
const QTY = 1e18;
const ACTIONS: TradeAction[] = ['long', 'short', 'half', 'close'];
type ContractLedgerInfo = Exclude<LedgerInfo, { mode: 'paper' }>;
const ERRORS: Record<string, string> = { Unauthorized: 'Only the match relayer can update this ledger.', InvalidMatch: 'Match is not open in the ledger.', InvalidClock: 'The ledger clock does not permit this operation.', NotActive: 'This duel is outside its trading window.', StaleQuote: 'Quote is older than five seconds, ahead of the deadline, or out of order.', InvalidQuote: 'A real bid, ask and mark are required for all six markets.', InvalidNonce: 'This action was already processed or arrived out of order.', Disabled: 'The account reached its $200 risk floor.', InsufficientMargin: 'Not enough available margin including spread, slippage and fees.', NoPosition: 'There is no position to close on this market.', InvalidOrder: 'This order is not supported.' };

export interface LedgerOptions {
  localProvider?: Eip1193Provider & { disconnect?: () => Promise<void> };
  mode?: 'local-evm' | 'monad';
  /** Injected test providers retain their intentional clock unless explicitly opted in. */
  syncLocalClock?: boolean;
}
export interface TradeResult { snapshot: LedgerSnapshot; txHash: string; fill?: { quantity: number; price: number; fee: number }; fills?: { action: TradeAction; quantity: number; price: number; fee: number }[] }

export class Ledger {
  readonly info: ContractLedgerInfo;
  private queue: Promise<unknown> = Promise.resolve();
  private lastQuotes = new Map<string, Quote[]>();
  constructor(private contract: Contract, info: ContractLedgerInfo, private disconnect?: () => Promise<void>, private prepareBlock?: () => Promise<void>) { this.info = info; }
  private queued<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work).catch(error => { throw this.friendly(error); });
    this.queue = next.catch(() => undefined);
    return next;
  }
  private friendly(error: any): Error {
    let name = error?.revert?.name;
    if (!name && typeof error?.data === 'string') { try { name = this.contract.interface.parseError(error.data)?.name; } catch { /* a transport error */ } }
    if (!name && typeof error?.info?.error?.data?.result === 'string') { try { name = this.contract.interface.parseError(error.info.error.data.result)?.name; } catch { /* a transport error */ } }
    if (name && ERRORS[name]) return new Error(ERRORS[name]);
    return new Error(error?.shortMessage || error?.message || 'The contract did not confirm this operation.');
  }
  private quotes(quotes: Quote[]) {
    if (quotes.length !== COINS.length || quotes.some((q, i) => q.coin !== COINS[i] || !Number.isFinite(q.mark) || !Number.isFinite(q.bid) || !Number.isFinite(q.ask) || q.mark <= 0 || q.bid <= 0 || q.ask < q.bid || !Number.isFinite(q.time))) throw new Error(ERRORS.InvalidQuote);
    const scaled = (n: number) => parseUnits(n.toFixed(8), 8);
    return quotes.map(q => ({ mark: scaled(q.mark), bid: scaled(q.bid), ask: scaled(q.ask), time: BigInt(Math.floor(q.time)) }));
  }
  private async confirm(method: string, args: unknown[]): Promise<TransactionReceipt> {
    // An instamining local EVM has no block while players wait in the lobby/countdown.
    // Advance its real block clock before estimateGas evaluates time-gated methods.
    await this.prepareBlock?.();
    const tx = await this.contract[method](...args);
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) throw new Error('The ledger transaction was not confirmed.');
    return receipt;
  }
  create(matchId: string, startAt: number, endAt: number): Promise<LedgerSnapshot> {
    return this.queued(async () => {
      if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || startAt % 1000 !== 0 || endAt % 1000 !== 0) throw new Error('The shared match clock must use whole seconds.');
      const receipt = await this.confirm('create', [hashId(matchId), Math.floor(startAt / 1000), Math.floor(endAt / 1000)]);
      return { ...await this.read(matchId), txHash: receipt.hash };
    });
  }
  update(matchId: string, quotes: Quote[]): Promise<LedgerSnapshot> {
    return this.queued(async () => {
      const receipt = await this.confirm('update', [hashId(matchId), this.quotes(quotes)]);
      this.lastQuotes.set(matchId, quotes.map(q => ({ ...q })));
      return { ...await this.read(matchId), txHash: receipt.hash };
    });
  }
  trade(matchId: string, seat: number, market: number, action: TradeAction, margin: number, nonce: number, quotes: Quote[]): Promise<TradeResult> {
    return this.queued(async () => {
      const actionIndex = ACTIONS.indexOf(action);
      if (seat < 0 || seat > 1 || market < 0 || market > 5 || actionIndex < 0 || !Number.isInteger(nonce) || nonce < 1) throw new Error(ERRORS.InvalidOrder);
      const current = await this.read(matchId);
      if (current.accounts[seat].disabled) throw new Error(ERRORS.Disabled);
      if (current.accounts[seat].nonce + 1 !== nonce) throw new Error(ERRORS.InvalidNonce);
      const snapshotQuotes = this.quotes(quotes);
      // Commit risk sampling independently. A later invalid/underfunded order must
      // not roll back a forced close or drawdown sample for either player's account.
      const samplingReceipt = await this.confirm('update', [hashId(matchId), snapshotQuotes]);
      this.lastQuotes.set(matchId, quotes.map(q => ({ ...q })));
      const sampled = await this.read(matchId);
      if (sampled.accounts[seat].disabled) return { snapshot: { ...sampled, txHash: samplingReceipt.hash }, txHash: samplingReceipt.hash };
      const receipt = await this.confirm('trade', [hashId(matchId), seat, market, actionIndex, parseUnits(margin.toFixed(8), 8), nonce, snapshotQuotes]);
      let fill: TradeResult['fill'];
      const fills: NonNullable<TradeResult['fills']> = [];
      for (const log of receipt.logs) {
        try {
          const event = this.contract.interface.parseLog(log);
          if (event?.name === 'Traded' && Number(event.args.seat) === seat && Number(event.args.market) === market) {
            const executed = { quantity: Number(event.args.quantity) / QTY, price: Number(event.args.price) / USD, fee: Number(event.args.fee) / USD };
            fills.push({ action: ACTIONS[Number(event.args.action)], ...executed });
            if (Number(event.args.action) === actionIndex) fill = executed;
          }
        } catch { /* logs from unrelated contracts are ignored */ }
      }
      return { snapshot: { ...await this.read(matchId), txHash: receipt.hash }, txHash: receipt.hash, fill, fills };
    });
  }
  settle(matchId: string, quotes: Quote[]): Promise<LedgerSnapshot> {
    return this.queued(async () => {
      const receipt = await this.confirm('settle', [hashId(matchId), this.quotes(quotes)]);
      this.lastQuotes.set(matchId, quotes.map(q => ({ ...q })));
      return { ...await this.read(matchId), txHash: receipt.hash };
    });
  }
  void(matchId: string, _reason?: string): Promise<void> { return this.queued(async () => { await this.confirm('voidMatch', [hashId(matchId)]); }); }
  async read(matchId: string): Promise<LedgerSnapshot> {
    const result = await this.contract.snapshot(hashId(matchId));
    const accounts = [0, 1].map(seat => {
      const a = result.accounts[seat];
      const account: Account = { cash: Number(a.cash) / USD, realizedPnl: Number(a.realizedPnl) / USD, fees: Number(a.fees) / USD, equity: Number(a.equity) / USD, unrealizedPnl: Number(a.unrealizedPnl) / USD, reservedMargin: Number(a.reservedMargin) / USD, availableMargin: Number(a.availableMargin) / USD, peakEquity: Number(a.peakEquity) / USD, maxDrawdown: Number(a.maxDrawdown) / USD, score: Number(a.score) / USD, disabled: a.disabled, nonce: Number(a.nonce), positions: [] };
      account.positions = COINS.flatMap((coin, market) => {
        const p = result.positions[seat][market];
        if (p.quantity === 0n) return [];
        const quantity = Number(p.quantity) / QTY, entry = Number(p.entry) / USD;
        const mark = this.lastQuotes.get(matchId)?.[market]?.mark ?? entry;
        return [{ coin, quantity, entry, margin: Number(p.margin) / USD, unrealizedPnl: quantity * (mark - entry) }];
      });
      return account;
    }) as [Account, Account];
    const winner = Number(result.winner);
    return { accounts, winner: winner < 0 ? null : winner };
  }
  async receipt(hash: string) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return null;
    const receipt = await this.contract.runner?.provider?.getTransactionReceipt(hash);
    if (!receipt || (receipt.to?.toLowerCase() !== this.info.contractAddress.toLowerCase() && receipt.contractAddress?.toLowerCase() !== this.info.contractAddress.toLowerCase())) return null;
    const events = receipt.logs.flatMap(log => {
      try {
        const parsed = this.contract.interface.parseLog(log);
        if (!parsed) return [];
        return [{ name: parsed.name, args: Object.fromEntries(parsed.fragment.inputs.map((input, i) => [input.name, String(parsed.args[i])])) }];
      } catch { return []; }
    });
    return { hash: receipt.hash, blockNumber: receipt.blockNumber, status: receipt.status, gasUsed: receipt.gasUsed.toString(), from: receipt.from, to: receipt.to, chainId: this.info.chainId, contractAddress: this.info.contractAddress, events };
  }
  async close() { await this.queue; await this.disconnect?.(); }
}

export async function createLedger(options: LedgerOptions = {}): Promise<Ledger> {
  if (!options.mode && process.env.LEDGER_MODE && !['local-evm', 'monad'].includes(process.env.LEDGER_MODE)) throw new Error('LEDGER_MODE must be local-evm or monad.');
  const mode = options.mode ?? (process.env.LEDGER_MODE === 'monad' ? 'monad' : 'local-evm');
  const artifact = compileContract();
  let signer: Signer, contract: Contract, info: ContractLedgerInfo, disconnect: (() => Promise<void>) | undefined, prepareBlock: (() => Promise<void>) | undefined;
  if (mode === 'monad') {
    const { RPC_URL, OPERATOR_PRIVATE_KEY, CONTRACT_ADDRESS } = process.env;
    if (!RPC_URL || !OPERATOR_PRIVATE_KEY || !CONTRACT_ADDRESS) throw new Error('LEDGER_MODE=monad requires RPC_URL, OPERATOR_PRIVATE_KEY and CONTRACT_ADDRESS. Keep the operator key only on the server.');
    if (!/^0x[0-9a-fA-F]{64}$/.test(OPERATOR_PRIVATE_KEY)) throw new Error('OPERATOR_PRIVATE_KEY must be a 0x-prefixed 32-byte server signer key. Its value is never logged.');
    // Disable RPC result caching so confirmed writes cannot reuse a stale operator nonce.
    const provider = new JsonRpcProvider(RPC_URL, undefined, { pollingInterval: 250, cacheTimeout: -1, batchMaxCount: 1 });
    const network = await provider.getNetwork();
    if (![10143n, 143n].includes(network.chainId)) throw new Error('The configured RPC is not Monad testnet (10143) or Monad mainnet (143).');
    const expected = BigInt(process.env.EXPECTED_CHAIN_ID || '10143');
    if (network.chainId !== expected) throw new Error(`RPC chain ${network.chainId} does not match EXPECTED_CHAIN_ID=${expected}.`);
    signer = new Wallet(OPERATOR_PRIVATE_KEY, provider);
    if (await provider.getCode(CONTRACT_ADDRESS) === '0x') throw new Error('No PaperDuel contract exists at CONTRACT_ADDRESS.');
    contract = new Contract(CONTRACT_ADDRESS, artifact.abi, signer);
    if ((await contract.relayer()).toLowerCase() !== (await signer.getAddress()).toLowerCase()) throw new Error('The configured signer is not this contract’s relayer.');
    info = { mode, chainId: Number(network.chainId), contractAddress: CONTRACT_ADDRESS, relayerAddress: await signer.getAddress(), explorer: network.chainId === 10143n ? 'https://testnet.monadexplorer.com' : 'https://monadvision.com' };
    disconnect = async () => provider.destroy();
  } else {
    let raw = options.localProvider;
    if (!raw) {
      const ganache = (await import('ganache')).default;
      raw = ganache.provider({ logging: { quiet: true }, wallet: { totalAccounts: 2, defaultBalance: 1000 }, chain: { chainId: 31337, hardfork: 'shanghai' }, miner: { instamine: 'eager' } }) as unknown as LedgerOptions['localProvider'];
    }
    if (!raw) throw new Error('Local EVM could not initialize.');
    const underlying = raw;
    const syncLocalClock = options.syncLocalClock ?? !options.localProvider;
    const alignLocalClock = async () => {
      if (!syncLocalClock) return;
      const block = await underlying.request({ method: 'eth_getBlockByNumber', params: ['latest', false] }) as { timestamp: string };
      const previousTime = Number(BigInt(block.timestamp)) * 1000;
      const waitMs = previousTime - Date.now();
      if (waitMs > 5_000) throw new Error('The local ledger clock is more than five seconds ahead. Synchronize the computer clock before restarting the server.');
      // Never rewind an existing block. A small initial/OS clock correction can
      // be caught up before deployment or the next write, then its persistent
      // Ganache offset is removed. Quotes keep their original timestamps.
      if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs + 5));
      const wallTime = Date.now();
      if (wallTime < previousTime) throw new Error('The computer clock changed while synchronizing the local ledger.');
      await underlying.request({ method: 'evm_setTime', params: [wallTime] });
    };
    await alignLocalClock();
    const provider = new BrowserProvider(raw, undefined, { cacheTimeout: -1 });
    provider.pollingInterval = 20;
    signer = await provider.getSigner(0);
    const deployed = await new ContractFactory(artifact.abi, artifact.bytecode, signer).deploy(await signer.getAddress());
    await deployed.waitForDeployment();
    contract = new Contract(await deployed.getAddress(), artifact.abi, signer);
    info = { mode, chainId: Number((await provider.getNetwork()).chainId), contractAddress: await contract.getAddress(), relayerAddress: await signer.getAddress() };
    prepareBlock = async () => { await alignLocalClock(); await underlying.request({ method: 'evm_mine', params: [] }); };
    disconnect = async () => { provider.destroy(); await underlying.disconnect?.(); };
  }
  return new Ledger(contract, info, disconnect, prepareBlock);
}
