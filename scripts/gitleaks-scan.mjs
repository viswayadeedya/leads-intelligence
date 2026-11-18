// Secret scan with gitleaks (https://github.com/gitleaks/gitleaks), an
// established open-source scanner. Two passes, both must be clean:
//
//   1. history   every commit on every branch (what a push would publish)
//   2. folder    the working folder as it is now, including files not yet
//                committed (folders that are never committed are skipped;
//                see .gitleaks.toml)
//
// A missing scanner is a FAILURE, not a skip: a check that silently does not
// run is worse than no check. Secrets are redacted in the output.
//
// Usage: node scripts/gitleaks-scan.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MIN_MAJOR = 8;
const MIN_MINOR = 25; // first version that reads the [[allowlists]] form used in .gitleaks.toml

function candidates() {
  const list = ['gitleaks'];
  if (process.platform === 'win32') {
    // winget installs here, and a shell opened before the install does not have it on PATH yet.
    if (process.env.LOCALAPPDATA) list.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'gitleaks.exe'));
    if (process.env.ProgramFiles) list.push(path.join(process.env.ProgramFiles, 'gitleaks', 'gitleaks.exe'));
  } else {
    list.push('/usr/local/bin/gitleaks', '/opt/homebrew/bin/gitleaks', '/usr/bin/gitleaks');
  }
  return list;
}

function findGitleaks() {
  for (const bin of candidates()) {
    const probe = spawnSync(bin, ['version'], { encoding: 'utf8' });
    if (probe.status === 0 && probe.stdout) return { bin, version: probe.stdout.trim().replace(/^v/, '') };
  }
  return null;
}

const found = findGitleaks();
if (!found) {
  console.error('gitleaks-scan: FAILED. gitleaks is not installed, so the secret scan did not run.');
  console.error('  Windows:  winget install --id Gitleaks.Gitleaks -e');
  console.error('  macOS:    brew install gitleaks');
  console.error('  Linux:    see https://github.com/gitleaks/gitleaks#installing');
  process.exit(2);
}
const [major, minor] = found.version.split('.').map(Number);
if (!(major > MIN_MAJOR || (major === MIN_MAJOR && minor >= MIN_MINOR))) {
  console.error(`gitleaks-scan: FAILED. gitleaks ${found.version} is too old; ${MIN_MAJOR}.${MIN_MINOR} or newer is needed.`);
  process.exit(2);
}

const common = ['--no-banner', '--redact', '--exit-code', '1', '--config', '.gitleaks.toml', '--log-level', 'warn', '--verbose'];
const isRepo = fs.existsSync(path.join(process.cwd(), '.git'));
const passes = [];
if (isRepo) passes.push({ name: 'history (all commits, all branches)', args: ['git', ...common, '--log-opts=--all', '.'] });
passes.push({ name: 'working folder', args: ['dir', ...common, '.'] });

let failed = false;
console.log(`gitleaks-scan: gitleaks ${found.version}`);
if (!isRepo) console.log('gitleaks-scan: not a git repository, so there is no history to scan.');
for (const pass of passes) {
  const run = spawnSync(found.bin, pass.args, { encoding: 'utf8' });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`.replace(/\u001b\[[0-9;]*m/g, '');
  const findings = (output.match(/^Finding:/gm) ?? []).length;
  if (run.status === 0) {
    console.log(`gitleaks-scan: ${pass.name}: 0 findings`);
  } else if (run.status === 1) {
    failed = true;
    console.log(`gitleaks-scan: ${pass.name}: ${findings} finding(s)`);
    for (const line of output.split(/\r?\n/)) {
      if (/^(Finding|RuleID|File|Line|Commit|Fingerprint):/.test(line)) console.log(`  ${line}`);
    }
  } else {
    failed = true;
    console.log(`gitleaks-scan: ${pass.name}: the scanner itself failed (exit ${run.status}).`);
    console.log(output.split(/\r?\n/).slice(-15).join('\n'));
  }
}
if (failed) {
  console.error('gitleaks-scan: FAILED. If a finding is a real secret: revoke it first, then remove it (history included).');
  console.error('  If it is a deliberate fake, mark that line with a gitleaks:allow comment that says why.');
  process.exit(1);
}
