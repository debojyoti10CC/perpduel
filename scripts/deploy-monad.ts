import 'dotenv/config';
import { ContractFactory, JsonRpcProvider, Wallet } from 'ethers';
import { compileContract } from '../server/compile.ts';

// Explicit opt-in: deployment spends testnet gas. No private key is ever printed or written.
if (process.env.CONFIRM_TESTNET_DEPLOY !== 'YES') throw new Error('Set CONFIRM_TESTNET_DEPLOY=YES to explicitly deploy to Monad testnet using operator gas.');
if (!process.env.RPC_URL || !process.env.OPERATOR_PRIVATE_KEY) throw new Error('Set RPC_URL and OPERATOR_PRIVATE_KEY in your private server environment.');
if (!/^0x[0-9a-fA-F]{64}$/.test(process.env.OPERATOR_PRIVATE_KEY)) throw new Error('OPERATOR_PRIVATE_KEY must be a 0x-prefixed 32-byte server signer key. Its value is never logged.');
// The foundation's public RPC accepts individual requests, not JSON-RPC batches.
const provider = new JsonRpcProvider(process.env.RPC_URL, undefined, { batchMaxCount: 1 });
try {
  const network = await provider.getNetwork();
  if (network.chainId !== 10143n) throw new Error('This deploy script only supports Monad testnet, chain 10143.');
  const operator = new Wallet(process.env.OPERATOR_PRIVATE_KEY, provider);
  const artifact = compileContract();
  const contract = await new ContractFactory(artifact.abi, artifact.bytecode, operator).deploy(await operator.getAddress());
  console.log(`Submitted: ${contract.deploymentTransaction()?.hash}`);
  await contract.waitForDeployment();
  console.log(`Confirmed PaperDuel: ${await contract.getAddress()}`);
  console.log('Set CONTRACT_ADDRESS to this address and LEDGER_MODE=monad on your server.');
} finally { provider.destroy(); }
