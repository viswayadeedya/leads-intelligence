// Operator live test launcher. Makes REAL requests to a real website.
//
// It investigates ONE business from an approvals file, and can reach only the
// exact hostnames approved for that business. Nothing else in this project can
// make a real request: the web app stays in mock mode.
//
// Usage:
//   node scripts/live-investigate.mjs --approvals <file.json> --business <LABEL> --confirm-live
//   node scripts/live-investigate.mjs --approvals <file.json> --list
//
// Without --confirm-live it prints what it WOULD contact and exits without
// making any request.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const CONFIRM_PHRASE = 'operator-approved-hosts-only';
const args = process.argv.slice(2);
const value = (name) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
};
const has = (name) => args.includes(name);
const fail = (message) => {
  console.error(`live-investigate: REFUSED. ${message}`);
  console.error('No request was made.');
  process.exit(2);
};

const known = new Set(['--approvals', '--business', '--confirm-live', '--list', '--out']);
for (const a of args) if (a.startsWith('--') && !known.has(a)) fail(`Unknown option ${a}.`);

const approvalsPath = value('--approvals');
if (!approvalsPath) fail('Give the approvals file: --approvals research-private/live-test/approvals.json');
const file = path.resolve(approvalsPath);
if (!fs.existsSync(file)) fail(`Approvals file not found: ${approvalsPath}`);
let approvals;
try {
  approvals = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch {
  fail('The approvals file is not valid JSON.');
}
const businesses = Array.isArray(approvals?.businesses) ? approvals.businesses : [];
if (businesses.length === 0) fail('The approvals file lists no businesses.');

// The approvals file names real businesses, so it and the output must stay out of version control.
const ignored = (target) => spawnSync('git', ['check-ignore', '-q', target], { stdio: 'ignore' }).status === 0;
const insideRepo = !path.relative(process.cwd(), file).startsWith('..');
if (insideRepo && fs.existsSync(path.join(process.cwd(), '.git')) && !ignored(file)) {
  fail(`The approvals file (${approvalsPath}) is inside the repository and is not ignored by git. Keep it under research-private/.`);
}
const out = path.resolve(value('--out') ?? path.dirname(file));
if (!path.relative(process.cwd(), out).startsWith('..') && fs.existsSync(path.join(process.cwd(), '.git')) && !ignored(path.join(out, 'x'))) {
  fail(`The output folder (${path.relative(process.cwd(), out) || '.'}) is not ignored by git. Reports about real businesses must not be committed.`);
}

if (has('--list')) {
  console.log(`Approved by: ${approvals.approvedBy} at ${approvals.approvedAt}`);
  for (const b of businesses) console.log(`  ${b.label}: ${Array.isArray(b.approvedHosts) ? b.approvedHosts.join(', ') : '(no hosts)'}`);
  process.exit(0);
}

const label = value('--business');
if (!label) fail(`Name one business: --business <LABEL>. Labels: ${businesses.map((b) => b.label).join(', ')}`);
const business = businesses.find((b) => b.label === label);
if (!business) fail(`No business labelled "${label}" in the approvals file. Labels: ${businesses.map((b) => b.label).join(', ')}`);

console.log('live-investigate: this will make real requests.');
console.log(`  business:  ${label}`);
console.log(`  may reach: ${Array.isArray(business.approvedHosts) ? business.approvedHosts.join(', ') : '(none)'}  (exactly these hostnames, nothing else)`);
console.log(`  approved:  by ${approvals.approvedBy} at ${approvals.approvedAt}`);
console.log('  method:    GET only; robots.txt honoured; at most 5 pages; 2 s between requests; no forms, cookies or logins');
console.log(`  output:    ${path.relative(process.cwd(), out) || '.'}`);
if (!has('--confirm-live')) {
  console.log('live-investigate: nothing was requested. Add --confirm-live to run it.');
  process.exit(0);
}

const require = createRequire(import.meta.url);
const vitestBin = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
const run = spawnSync(process.execPath, [vitestBin, 'run', '--config', 'tools/live-test/vitest.live.config.mts', '--reporter=default'], {
  stdio: 'inherit',
  env: { ...process.env, OI_LIVE_CONFIRM: CONFIRM_PHRASE, OI_LIVE_APPROVALS: file, OI_LIVE_BUSINESS: label, OI_LIVE_OUT: out },
});
process.exit(run.status ?? 1);
