import fs from 'node:fs';
import path from 'node:path';
import { compileContract, projectRoot } from '../server/compile.ts';
const artifact = compileContract();
fs.mkdirSync(path.join(projectRoot, 'artifacts'), { recursive: true });
fs.writeFileSync(path.join(projectRoot, 'artifacts/PaperDuel.json'), JSON.stringify(artifact, null, 2));
console.log(`PaperDuel compiled: ${(artifact.bytecode.length - 2) / 2} deployment bytes. Artifact: artifacts/PaperDuel.json`);
