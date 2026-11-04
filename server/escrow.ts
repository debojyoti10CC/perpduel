import { Contract, JsonRpcProvider, Wallet, ZeroAddress, getAddress, parseEther } from 'ethers';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { compileEscrow } from '../scripts/compile-escrow.ts';
import { ESCROW_ABI, ESCROW_CHAIN_ID, signResolution, type Resolution } from '../shared/escrow.ts';

export interface EscrowConfiguration { contractAddress: string; owner: string; transactionHash: string }
export interface ChainRoom { creator: string; opponent: string; stake: bigint; refundAfter: number; status: number }
export async function loadResultSigner(directory: string): Promise<Wallet> {
  if (process.env.RESULT_SIGNER_PRIVATE_KEY) return new Wallet(process.env.RESULT_SIGNER_PRIVATE_KEY);
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, 'escrow-result-signer.json');
  try { return new Wallet(JSON.parse(await readFile(file, 'utf8')).privateKey); }
  catch (error: any) { if (error.code !== 'ENOENT') throw new Error('The saved result signer is unreadable. It was not replaced.'); }
  const signer = Wallet.createRandom();
  try { await writeFile(file, JSON.stringify({ privateKey: signer.privateKey }), { flag: 'wx', mode: 0o600 }); }
  catch (error: any) { if (error.code !== 'EEXIST') throw error; return new Wallet(JSON.parse(await readFile(file, 'utf8')).privateKey); }
  return new Wallet(signer.privateKey);
}

export class EscrowService {
  private readonly rpcUrl = process.env.ESCROW_RPC_URL || 'https://testnet-rpc.monad.xyz';
  private readonly publicRpcUrl = process.env.PUBLIC_MONAD_RPC_URL || 'https://testnet-rpc.monad.xyz';
  readonly explorer = 'https://testnet.monadvision.com';
  readonly provider = new JsonRpcProvider(this.rpcUrl, ESCROW_CHAIN_ID, { batchMaxCount: 1 });
  private signer!: Wallet;
  private configuration: EscrowConfiguration | null = null;
  private verified = false;
  private reason = 'Deploy and register the Monad testnet room escrow to enable MON stakes.';
  private registerQueue: Promise<unknown> = Promise.resolve();
  constructor(private readonly directory: string) {}
  async start(): Promise<void> {
    this.signer = await loadResultSigner(this.directory);
    if (process.env.ESCROW_CONTRACT_ADDRESS) this.configuration = { contractAddress: getAddress(process.env.ESCROW_CONTRACT_ADDRESS), owner: 'environment', transactionHash: '' };
    else {
      try { this.configuration = JSON.parse(await readFile(path.join(this.directory, 'escrow-config.json'), 'utf8')); }
      catch (error: any) { if (error.code !== 'ENOENT') throw new Error('The saved escrow configuration is unreadable. It was not replaced.'); }
    }
    if (this.configuration) {
      try { await this.validateContract(this.configuration.contractAddress); this.verified = true; this.reason = ''; }
      catch { this.reason = 'The configured Monad escrow could not be verified. Check its RPC, chain, contract, and result signer.'; }
    }
  }
  config() {
    return { chainId: ESCROW_CHAIN_ID, configured: Boolean(this.configuration), enabled: this.verified, resultSigner: this.signer.address, resultSignerAddress: this.signer.address, contractAddress: this.configuration?.contractAddress ?? null, rpcUrl: this.publicRpcUrl, explorer: this.explorer, reason: this.reason || null };
  }
  requireAddress(): string {
    if (!this.configuration || !this.verified) throw new Error(this.reason || 'Monad escrow is not configured.');
    return this.configuration.contractAddress;
  }
  private async validateContract(address: string): Promise<void> {
    const network = await this.provider.getNetwork();
    if (network.chainId !== BigInt(ESCROW_CHAIN_ID)) throw new Error('Escrow requires Monad testnet chain 10143.');
    const code = (await this.provider.getCode(address)).slice(2).toLowerCase();
    const artifact = compileEscrow();
    let expected = artifact.deployedBytecode.slice(2).toLowerCase();
    let actual = code;
    if (!actual || actual.length !== expected.length) throw new Error('The deployed escrow does not match this application.');
    for (const references of Object.values(artifact.immutableReferences) as { start: number; length: number }[][]) for (const reference of references) {
      const begin = reference.start * 2, end = begin + reference.length * 2;
      expected = expected.slice(0, begin) + '0'.repeat(end - begin) + expected.slice(end);
      actual = actual.slice(0, begin) + '0'.repeat(end - begin) + actual.slice(end);
    }
    if (actual !== expected) throw new Error('The deployed escrow does not match this application.');
    const contract = new Contract(address, ESCROW_ABI, this.provider);
    if (getAddress(await contract.resultSigner()) !== this.signer.address) throw new Error('Escrow result signer does not match this server.');
  }
  register(owner: string, value: unknown): Promise<ReturnType<EscrowService['config']>> {
    const operation = this.registerQueue.then(async () => {
      const input = value as { contractAddress?: string; transactionHash?: string };
      if (!input || typeof input.contractAddress !== 'string' || typeof input.transactionHash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(input.transactionHash)) throw new Error('Supply the deployed escrow address and confirmed deployment transaction.');
      const address = getAddress(input.contractAddress);
      if (this.configuration) {
        if (getAddress(this.configuration.contractAddress) !== address) throw new Error('This server already has a configured escrow.');
        await this.validateContract(address); this.verified = true; this.reason = ''; return this.config();
      }
      await this.validateContract(address);
      const receipt = await this.provider.getTransactionReceipt(input.transactionHash);
      if (!receipt || receipt.status !== 1 || !receipt.contractAddress || getAddress(receipt.contractAddress) !== address || getAddress(receipt.from) !== getAddress(owner)) throw new Error('The deployment must be confirmed and sent by your authenticated wallet.');
      const configuration = { contractAddress: address, owner: getAddress(owner), transactionHash: input.transactionHash };
      const file = path.join(this.directory, 'escrow-config.json');
      await writeFile(`${file}.tmp`, JSON.stringify(configuration, null, 2));
      await rename(`${file}.tmp`, file);
      this.configuration = configuration; this.verified = true; this.reason = '';
      return this.config();
    });
    this.registerQueue = operation.catch(() => {});
    return operation;
  }
  async room(roomId: string, contractAddress = this.requireAddress()): Promise<ChainRoom> {
    if (getAddress(contractAddress) !== getAddress(this.requireAddress())) throw new Error('Room escrow differs from the configured contract.');
    await this.provider.getNetwork();
    const contract = new Contract(contractAddress, ESCROW_ABI, this.provider);
    const room = await contract.getRoom(roomId);
    return { creator: getAddress(room.creator), opponent: getAddress(room.opponent), stake: BigInt(room.stake), refundAfter: Number(room.refundAfter), status: Number(room.status) };
  }
  async verifyRoom(roomId: string, creator: string, opponent: string | undefined, amount: number, refundAfter: number): Promise<ChainRoom> {
    const chain = await this.room(roomId);
    if (chain.status === 0) return chain;
    if (chain.creator !== getAddress(creator) || chain.stake !== parseEther(String(amount)) || chain.refundAfter !== refundAfter) throw new Error('On-chain creator, stake, or refund deadline does not match this room.');
    if (chain.status >= 2 && chain.opponent !== ZeroAddress && opponent && chain.opponent !== getAddress(opponent)) throw new Error('The funded opponent does not own this player seat.');
    return chain;
  }
  async resolution(value: Resolution, contractAddress: string) {
    const signature = await signResolution(this.signer, contractAddress, value);
    return { ...value, signature, contractAddress, chainId: ESCROW_CHAIN_ID };
  }
  async close(): Promise<void> { await this.registerQueue; this.provider.destroy(); }
}
