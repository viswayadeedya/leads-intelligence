// Builds the app with CANARY secret values in the environment, then proves
// that neither the canary values nor server-only variable names reach anything
// the browser can download (.next/static). Also fails on shipped source maps.
// Usage: node scripts/check-client-bundle.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CANARIES = {
  SUPABASE_SERVICE_ROLE_KEY: 'canary-service-role-9f3a61',
  SUPABASE_ANON_KEY: 'canary-anon-key-2b7e40',
  LLM_API_KEY: 'canary-llm-key-77c1d2',
  GOOGLE_PLACES_API_KEY: 'canary-places-key-c05a19',
  DATABASE_URL: 'canary-database-url-e41b88',
  OPERATOR_PASSPHRASE: 'canary-passphrase-51de07',
};
const SERVER_ONLY_NAMES = ['SUPABASE_SERVICE_ROLE_KEY', 'LLM_API_KEY', 'GOOGLE_PLACES_API_KEY', 'DATABASE_URL', 'OPERATOR_PASSPHRASE'];

const build = spawnSync(process.execPath, ['scripts/run-next.mjs', 'build'], { stdio: 'inherit', env: { ...process.env, ...CANARIES } });
if (build.status !== 0) {
  console.error('check-client-bundle: build failed');
  process.exit(1);
}

const staticDir = path.join(process.cwd(), '.next', 'static');
const findings = [];
let files = 0;
let bytes = 0;
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    files++;
    const rel = path.relative(process.cwd(), full).replaceAll('\\', '/');
    if (entry.name.endsWith('.map')) findings.push(`${rel}  source map shipped to the browser`);
    const text = fs.readFileSync(full, 'latin1');
    bytes += text.length;
    for (const [name, value] of Object.entries(CANARIES)) {
      if (text.includes(value)) findings.push(`${rel}  contains the value of ${name}`);
    }
    for (const name of SERVER_ONLY_NAMES) {
      if (text.includes(name)) findings.push(`${rel}  mentions server-only variable ${name}`);
    }
  }
}
if (!fs.existsSync(staticDir)) {
  console.error('check-client-bundle: .next/static not found');
  process.exit(1);
}
walk(staticDir);

console.log(`check-client-bundle: ${files} browser-downloadable files (${bytes} bytes) scanned, ${findings.length} finding(s)`);
if (findings.length > 0) {
  for (const f of findings) console.log(`  ${f}`);
  process.exit(1);
}
