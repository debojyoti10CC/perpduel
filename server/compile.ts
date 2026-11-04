import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let artifact: { abi: any[]; bytecode: string } | undefined;
export function compileContract() {
  if (artifact) return artifact;
  const source = fs.readFileSync(path.join(root, 'contracts/PaperDuel.sol'), 'utf8');
  const result = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { 'PaperDuel.sol': { content: source } }, settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: 'shanghai', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } })));
  const errors = result.errors?.filter((e: { severity: string }) => e.severity === 'error');
  if (errors?.length) throw new Error(errors.map((e: { formattedMessage: string }) => e.formattedMessage).join('\n'));
  const output = result.contracts['PaperDuel.sol'].PaperDuel;
  artifact = { abi: output.abi, bytecode: `0x${output.evm.bytecode.object}` };
  return artifact;
}
export { root as projectRoot };
