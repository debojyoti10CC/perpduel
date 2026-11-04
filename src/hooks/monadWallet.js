import { BrowserProvider, Contract, ContractFactory, JsonRpcProvider, formatEther, getAddress, parseEther } from 'ethers';
import { ESCROW_ABI, ESCROW_CHAIN_ID, roomKey } from '../../shared/escrow.ts';

// Official network settings: https://docs.monad.xyz/developer-essentials/testnet
export const MONAD_TESTNET = {
  chainId: '0x279f',
  chainName: 'Monad Testnet',
  nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
  rpcUrls: ['https://testnet-rpc.monad.xyz'],
  blockExplorerUrls: ['https://testnet.monadvision.com'],
};
let connectedAddress = null;
let artifactPromise = null;
let readProvider = null;
const escrowKey = roomId => /^0x[0-9a-fA-F]{64}$/.test(roomId) ? roomId : roomKey(roomId);

function injected() {
  if (!window.ethereum?.request) throw new Error('Install an EVM wallet to use Monad testnet.');
  return window.ethereum;
}

async function ensureMonad(wallet) {
  if (Number(await wallet.request({ method: 'eth_chainId' })) === ESCROW_CHAIN_ID) return;
  try {
    await wallet.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: MONAD_TESTNET.chainId }] });
  } catch (error) {
    const code = error?.code ?? error?.data?.originalError?.code ?? error?.info?.error?.code;
    if (code !== 4902) throw error;
    await wallet.request({ method: 'wallet_addEthereumChain', params: [MONAD_TESTNET] });
    await wallet.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: MONAD_TESTNET.chainId }] });
  }
  if (Number(await wallet.request({ method: 'eth_chainId' })) !== ESCROW_CHAIN_ID) throw new Error('Switch your wallet to Monad testnet (10143).');
}

async function walletSession() {
  const wallet = injected();
  const accounts = await wallet.request({ method: 'eth_accounts' });
  if (!accounts?.[0] || !connectedAddress) throw new Error('Connect and verify your wallet before funding a room.');
  const address = getAddress(accounts[0]);
  if (address !== connectedAddress) throw new Error('Your wallet account changed. Connect and verify it again.');
  await ensureMonad(wallet);
  const provider = new BrowserProvider(wallet, 'any');
  const signer = await provider.getSigner(address);
  return { address, provider, signer };
}

export async function connectMonadWallet() {
  const wallet = injected();
  const accounts = await wallet.request({ method: 'eth_requestAccounts' });
  if (!accounts?.[0]) throw new Error('No wallet account was selected.');
  await ensureMonad(wallet);
  const provider = new BrowserProvider(wallet, 'any');
  const address = getAddress(accounts[0]);
  const signer = await provider.getSigner(address);
  const balanceWei = await provider.getBalance(address);
  connectedAddress = address;
  return { address, provider, signer, balance: formatEther(balanceWei), balanceWei };
}

export async function signWalletNonce(message) {
  if (typeof message !== 'string' || !message.trim()) throw new Error('The server did not provide an authentication message.');
  const { address, signer } = await walletSession();
  return { address, signature: await signer.signMessage(message) };
}

async function artifact() {
  if (!artifactPromise) {
    artifactPromise = fetch('/escrow/RoomEscrow.json', { credentials: 'same-origin' }).then(async response => {
      if (!response.ok) throw new Error('The room escrow artifact is unavailable. Run npm run compile:escrow.');
      const value = await response.json();
      if (!Array.isArray(value.abi) || !/^0x[0-9a-f]+$/i.test(value.bytecode)) throw new Error('Invalid room escrow artifact.');
      return value;
    }).catch(error => { artifactPromise = null; throw error; });
  }
  return artifactPromise;
}

function positiveStake(amount) {
  const stake = parseEther(String(amount));
  if (stake <= 0n) throw new Error('Enter a positive MON stake.');
  return stake;
}

async function transact(contractAddress, action) {
  const { signer } = await walletSession();
  const escrow = new Contract(getAddress(contractAddress), ESCROW_ABI, signer);
  const transaction = await action(escrow);
  const receipt = await transaction.wait(1);
  if (!receipt || receipt.status !== 1) throw new Error('The Monad testnet transaction was not confirmed.');
  return { transactionHash: receipt.hash, receipt };
}

export async function deployEscrow(resultSigner) {
  const { signer } = await walletSession();
  const deployment = await artifact();
  const contract = await new ContractFactory(deployment.abi, deployment.bytecode, signer).deploy(getAddress(resultSigner));
  await contract.waitForDeployment();
  const receipt = await contract.deploymentTransaction().wait(1);
  if (!receipt || receipt.status !== 1) throw new Error('Escrow deployment was not confirmed.');
  return { address: await contract.getAddress(), transactionHash: receipt.hash };
}

export const createEscrowRoom = (address, roomId, amount, refundAfter) => transact(address, escrow => escrow.createRoom(escrowKey(roomId), refundAfter, { value: positiveStake(amount) }));
export const joinEscrowRoom = (address, roomId, amount) => transact(address, escrow => escrow.joinRoom(escrowKey(roomId), { value: positiveStake(amount) }));
export const resolveEscrowRoom = (address, voucher) => {
  if (voucher.chainId !== undefined && Number(voucher.chainId) !== ESCROW_CHAIN_ID) throw new Error('The result is for a different chain.');
  if (voucher.contractAddress && getAddress(voucher.contractAddress) !== getAddress(address)) throw new Error('The result is for a different escrow.');
  return transact(address, escrow => escrow.resolve(escrowKey(voucher.roomId), voucher.winner, voucher.deadline, voucher.signature));
};
export const withdrawEscrowCredit = address => transact(address, escrow => escrow.withdraw());
export const cancelEscrowRoom = (address, roomId) => transact(address, escrow => escrow.cancelUnjoined(escrowKey(roomId)));
export const refundEscrowRoom = (address, roomId) => transact(address, escrow => escrow.refundExpired(escrowKey(roomId)));

export async function readEscrowBalance(contractAddress, address) {
  readProvider ??= new JsonRpcProvider(MONAD_TESTNET.rpcUrls[0], ESCROW_CHAIN_ID, { batchMaxCount: 1 });
  const wallet = getAddress(address);
  const escrow = new Contract(getAddress(contractAddress), ESCROW_ABI, readProvider);
  const [balanceWei, creditWei] = await Promise.all([readProvider.getBalance(wallet), escrow.credits(wallet)]);
  return { balance: formatEther(balanceWei), balanceWei, credit: formatEther(creditWei), creditWei };
}

export async function readEscrowRoom(contractAddress, roomId) {
  readProvider ??= new JsonRpcProvider(MONAD_TESTNET.rpcUrls[0], ESCROW_CHAIN_ID, { batchMaxCount: 1 });
  const escrow = new Contract(getAddress(contractAddress), ESCROW_ABI, readProvider);
  const room = await escrow.getRoom(escrowKey(roomId));
  return { creator: room.creator, opponent: room.opponent, stake: formatEther(room.stake), stakeWei: room.stake, refundAfter: Number(room.refundAfter), status: Number(room.status) };
}
