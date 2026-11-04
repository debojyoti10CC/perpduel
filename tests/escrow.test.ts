import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import ganache from 'ganache';
import { BrowserProvider, Contract, ContractFactory, Wallet, ZeroAddress, ZeroHash, parseEther } from 'ethers';
// @ts-ignore
import solc from 'solc';
import { compileEscrow } from '../scripts/compile-escrow.ts';
import { escrowDomain, RESOLVE_TYPES, roomKey, signResolution } from '../shared/escrow.ts';

let raw: ReturnType<typeof ganache.provider>;
let provider: BrowserProvider;
let host: any; let guest: any; let outsider: any;
let artifact: ReturnType<typeof compileEscrow>;
const authority = Wallet.createRandom();
const stake = parseEther('0.1');
const rejected = (operation: Promise<any>) => assert.rejects(async () => {
  const result = await operation;
  if (typeof result?.wait === 'function') await result.wait();
  else if (typeof result?.waitForDeployment === 'function') await result.waitForDeployment();
});
let sequence = 0;
const timestamp = async () => Number(BigInt((await raw.request({ method: 'eth_getBlockByNumber', params: ['latest', false] }) as any).timestamp));
const balance = async (address: string) => BigInt(await raw.request({ method: 'eth_getBalance', params: [address, 'latest'] }) as string);
const advance = async (seconds: number) => { await raw.request({ method: 'evm_increaseTime', params: [seconds] }); await raw.request({ method: 'evm_mine', params: [] }); };
async function deploy() { const contract = await new ContractFactory(artifact.abi, artifact.bytecode, host).deploy(authority.address); await contract.waitForDeployment(); return contract as any; }
async function room(joined = true) {
  const escrow = await deploy(); const id = roomKey(`escrow-${++sequence}`); const expiry = await timestamp() + 3600;
  await (await escrow.createRoom(id, expiry, { value: stake })).wait();
  if (joined) await (await escrow.connect(guest).joinRoom(id, { value: stake })).wait();
  return { escrow, id, expiry };
}
async function voucher(escrow: any, id: string, winner: string, deadline: number) {
  return signResolution(authority, await escrow.getAddress(), { roomId: id, winner, deadline });
}

before(async () => {
  artifact = compileEscrow();
  raw = ganache.provider({ logging: { quiet: true }, chain: { chainId: 10143, hardfork: 'shanghai' }, wallet: { totalAccounts: 4 }, miner: { instamine: 'eager', timestampIncrement: 0 } });
  provider = new BrowserProvider(raw as any); provider.pollingInterval = 10;
  [host, guest, outsider] = await Promise.all([0, 1, 2].map(index => provider.getSigner(index)));
});
after(async () => { provider?.destroy(); await raw?.disconnect(); });

test('escrows native MON and pays only the attested winner through pull credit', async () => {
  const { escrow, id, expiry } = await room();
  const view = await escrow.getRoom(id);
  assert.equal(view.creator, await host.getAddress()); assert.equal(view.opponent, await guest.getAddress());
  assert.equal(view.stake, stake); assert.equal(view.status, 2n);
  assert.equal(await balance(await escrow.getAddress()), stake * 2n);
  const signature = await voucher(escrow, id, await host.getAddress(), expiry - 1);
  await (await escrow.connect(outsider).resolve(id, await host.getAddress(), expiry - 1, signature)).wait();
  assert.equal(await escrow.credits(await host.getAddress()), stake * 2n);
  assert.equal(await escrow.credits(await guest.getAddress()), 0n);
  await rejected(escrow.connect(guest).withdraw());
  await (await escrow.withdraw()).wait();
  assert.equal(await escrow.credits(await host.getAddress()), 0n);
  assert.equal(await balance(await escrow.getAddress()), 0n);
  await rejected(escrow.withdraw());
});

test('rejects invalid room keys, zero stake, colliding keys and extreme expiry', async () => {
  const { escrow, id, expiry } = await room(false);
  await rejected(escrow.createRoom(ZeroHash, expiry, { value: stake }));
  await rejected(escrow.createRoom(id, expiry, { value: stake }));
  await rejected(escrow.createRoom(roomKey('zero-stake'), expiry));
  await rejected(escrow.createRoom(roomKey('early'), await timestamp() + 10, { value: stake }));
  await rejected(escrow.createRoom(roomKey('late'), await timestamp() + 604801, { value: stake }));
  await rejected(host.sendTransaction({ to: await escrow.getAddress(), value: 1n }));
  await rejected(new ContractFactory(artifact.abi, artifact.bytecode, host).deploy(ZeroAddress));
});

test('rejects self matches, unequal stake and any third player', async () => {
  const { escrow, id } = await room(false);
  await rejected(escrow.joinRoom(id, { value: stake }));
  await rejected(escrow.connect(guest).joinRoom(id, { value: stake - 1n }));
  await (await escrow.connect(guest).joinRoom(id, { value: stake })).wait();
  await rejected(escrow.connect(outsider).joinRoom(id, { value: stake }));
  await rejected(escrow.cancelUnjoined(id));
});

test('requires the result signer, exact winner, correct EIP712 chain and escrow domain', async () => {
  const { escrow, id, expiry } = await room(); const deadline = expiry - 1; const winner = await host.getAddress();
  const message = { roomId: id, winner, deadline }; const address = await escrow.getAddress();
  const valid = await voucher(escrow, id, winner, deadline);
  await rejected(escrow.resolve(id, await outsider.getAddress(), deadline, valid));
  await rejected(escrow.resolve(id, await guest.getAddress(), deadline, valid));
  await rejected(escrow.resolve(id, winner, deadline, '0x1234'));
  const otherSigner = await Wallet.createRandom().signTypedData(escrowDomain(address), RESOLVE_TYPES, message);
  await rejected(escrow.resolve(id, winner, deadline, otherSigner));
  const otherChain = await authority.signTypedData({ ...escrowDomain(address), chainId: 143 }, RESOLVE_TYPES, message);
  await rejected(escrow.resolve(id, winner, deadline, otherChain));
  const otherEscrow = await authority.signTypedData(escrowDomain(await outsider.getAddress()), RESOLVE_TYPES, message);
  await rejected(escrow.resolve(id, winner, deadline, otherEscrow));
  const expired = await voucher(escrow, id, winner, await timestamp() - 1);
  await rejected(escrow.resolve(id, winner, await timestamp() - 1, expired));
  const late = await voucher(escrow, id, winner, expiry + 1);
  await rejected(escrow.resolve(id, winner, expiry + 1, late));
  await (await escrow.resolve(id, winner, deadline, valid)).wait();
  await rejected(escrow.resolve(id, winner, deadline, valid));
  await rejected(escrow.refundExpired(id));
});

test('a signed draw refunds each player exactly their own stake', async () => {
  const { escrow, id, expiry } = await room();
  const signature = await voucher(escrow, id, ZeroAddress, expiry - 1);
  await (await escrow.resolve(id, ZeroAddress, expiry - 1, signature)).wait();
  assert.equal(await escrow.credits(await host.getAddress()), stake);
  assert.equal(await escrow.credits(await guest.getAddress()), stake);
  await (await escrow.withdraw()).wait(); await (await escrow.connect(guest).withdraw()).wait();
  assert.equal(await balance(await escrow.getAddress()), 0n);
});

test('only the host can cancel an unjoined room and room IDs cannot be reused', async () => {
  const { escrow, id, expiry } = await room(false);
  await rejected(escrow.connect(guest).cancelUnjoined(id));
  await (await escrow.cancelUnjoined(id)).wait();
  assert.equal((await escrow.getRoom(id)).status, 4n);
  assert.equal(await escrow.credits(await host.getAddress()), stake);
  await rejected(escrow.cancelUnjoined(id));
  await rejected(escrow.createRoom(id, expiry, { value: stake }));
});

test('expired open or joined rooms can be refunded without the server or either player', async () => {
  const solo = await room(false); const joined = await room();
  await rejected(joined.escrow.refundExpired(joined.id));
  await advance(3601);
  await (await solo.escrow.connect(outsider).refundExpired(solo.id)).wait();
  await (await joined.escrow.connect(outsider).refundExpired(joined.id)).wait();
  assert.equal(await solo.escrow.credits(await host.getAddress()), stake);
  assert.equal(await joined.escrow.credits(await host.getAddress()), stake);
  assert.equal(await joined.escrow.credits(await guest.getAddress()), stake);
  const signature = await voucher(joined.escrow, joined.id, await host.getAddress(), joined.expiry);
  await rejected(joined.escrow.resolve(joined.id, await host.getAddress(), joined.expiry, signature));
  await rejected(joined.escrow.refundExpired(joined.id));
});

test('failed withdrawals preserve credit and reentrant recipients cannot withdraw twice', async () => {
  const escrow = await deploy();
  const source = `pragma solidity ^0.8.24;
    interface Escrow { function createRoom(bytes32,uint64) external payable; function cancelUnjoined(bytes32) external; function withdraw() external; }
    contract Recipient { Escrow public target; bool public rejectPayment; bool public attempted;
      constructor(address escrow) { target=Escrow(escrow); }
      function create(bytes32 id,uint64 expiry) external payable { target.createRoom{value:msg.value}(id,expiry); }
      function cancel(bytes32 id) external { target.cancelUnjoined(id); }
      function setReject(bool value) external { rejectPayment=value; }
      function claim() external { target.withdraw(); }
      receive() external payable { require(!rejectPayment); attempted=true; try target.withdraw() {} catch {} }
    }`;
  const output = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { 'Recipient.sol': { content: source } }, settings: { evmVersion: 'shanghai', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } })));
  const compiled = output.contracts['Recipient.sol'].Recipient;
  const recipient = await new ContractFactory(compiled.abi, `0x${compiled.evm.bytecode.object}`, host).deploy(await escrow.getAddress()) as any;
  await recipient.waitForDeployment(); const id = roomKey('recipient');
  await (await recipient.create(id, await timestamp() + 3600, { value: stake })).wait();
  await (await recipient.cancel(id)).wait(); await (await recipient.setReject(true)).wait();
  await rejected(recipient.claim());
  assert.equal(await escrow.credits(await recipient.getAddress()), stake);
  await (await recipient.setReject(false)).wait(); await (await recipient.claim({ gasLimit: 500000 })).wait();
  assert.equal(await recipient.attempted(), true);
  assert.equal(await balance(await recipient.getAddress()), stake);
  assert.equal(await escrow.credits(await recipient.getAddress()), 0n);
});

test('cannot deploy the fund-holding contract on a mainnet or another chain', async () => {
  const wrong = ganache.provider({ logging: { quiet: true }, chain: { chainId: 143, hardfork: 'shanghai' } });
  const wrongProvider = new BrowserProvider(wrong as any);
  try { await rejected(new ContractFactory(artifact.abi, artifact.bytecode, await wrongProvider.getSigner()).deploy(authority.address)); }
  finally { wrongProvider.destroy(); await wrong.disconnect(); }
});
