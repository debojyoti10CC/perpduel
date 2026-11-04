import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// solc's JavaScript package does not ship TypeScript declarations.
// @ts-ignore
import solc from 'solc';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function compileEscrow() {
  const source = fs.readFileSync(path.join(root, 'contracts/RoomEscrow.sol'), 'utf8');
  const input = {
    language: 'Solidity',
    sources: { 'RoomEscrow.sol': { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'shanghai',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences'] } },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors ?? []).filter((entry: { severity: string }) => entry.severity === 'error');
  if (errors.length) throw new Error(errors.map((entry: { formattedMessage: string }) => entry.formattedMessage).join('\n'));
  const contract = output.contracts['RoomEscrow.sol'].RoomEscrow;
  return {
    contractName: 'RoomEscrow',
    compiler: (solc as unknown as { version(): string }).version(),
    chainId: 10143,
    abi: contract.abi,
    bytecode: `0x${contract.evm.bytecode.object}`,
    deployedBytecode: `0x${contract.evm.deployedBytecode.object}`,
    immutableReferences: contract.evm.deployedBytecode.immutableReferences,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const artifact = compileEscrow();
  const outputPath = path.join(root, 'public/escrow/RoomEscrow.json');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`RoomEscrow compiled: ${(artifact.bytecode.length - 2) / 2} deployment bytes; public/escrow/RoomEscrow.json`);
}
