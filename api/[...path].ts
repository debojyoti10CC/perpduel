import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server/vercel-runtime.mjs';

// One Vercel function owns the HTTP API and its WebSocket endpoint so both use
// the same MatchManager within a warm function instance.
const app = await startServer({
  production: true,
  listen: false,
  dataDir: join(tmpdir(), 'perpduel'),
});

export default app.server;
