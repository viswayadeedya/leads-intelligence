// Starts Next.js with framework telemetry disabled, so the app makes no
// outbound calls of its own. Usage: node scripts/run-next.mjs <dev|build|start> [args]
//
// --oi-data-dir=<folder> runs against a different data folder (same as setting
// OI_DATA_DIR). Used to try the app without touching the real local data.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const nextBin = require.resolve('next/dist/bin/next');
const env = { ...process.env, NEXT_TELEMETRY_DISABLED: '1' };
const args = [];
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('--oi-data-dir=')) env.OI_DATA_DIR = arg.slice('--oi-data-dir='.length);
  else args.push(arg);
}
const child = spawn(process.execPath, [nextBin, ...args], { stdio: 'inherit', env });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
