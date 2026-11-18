// Local secret scan. A STOPGAP, not a replacement for gitleaks: it checks a
// short list of well-known key shapes and project-specific rules. Exit code 1
// on any finding. Usage: node scripts/secret-scan.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', '.data', 'coverage']);
const SKIP_FILES = new Set(['package-lock.json']);
const MAX_BYTES = 2_000_000;

const PATTERNS = [
  ['private key block', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/],
  ['AWS access key id', /\bAKIA[0-9A-Z]{16}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ['Stripe live key', /\b[sr]k_live_[A-Za-z0-9]{16,}/],
  ['OpenAI/Anthropic style key', /\bsk-(?:ant-)?[A-Za-z0-9_-]{24,}\b/],
  ['JWT (e.g. Supabase key)', /\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/],
  ['database URL with password', /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s:@/]+:[^\s@/]{3,}@/],
  // Not a secret, but it publishes an operating-system account name (found in captured test output).
  ['local user directory path', /\b[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s<]+|(?:^|[\s"'(=])\/(?:Users|home)\/[A-Za-z0-9._-]+\//],
];
// Hard-coded credential assignments in application code.
const ASSIGNMENT = /\b[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSPHRASE|API_KEY|SERVICE_ROLE_KEY|ANON_KEY)[A-Z0-9_]*\s*[:=]\s*['"`][^'"`\s]{12,}['"`]/;

const findings = [];
let scanned = 0;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(ROOT, full).replaceAll('\\', '/');
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full);
      continue;
    }
    if (SKIP_FILES.has(entry.name)) continue;
    const stat = fs.statSync(full);
    if (stat.size > MAX_BYTES) continue;
    const text = fs.readFileSync(full, 'utf8');
    if (text.includes('\u0000')) continue; // binary
    scanned++;
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const [name, re] of PATTERNS) {
        if (re.test(line)) findings.push(`${rel}:${i + 1}  ${name}`);
      }
      // tests and this scanner contain deliberately fake values
      if (!rel.startsWith('tests/') && !rel.startsWith('scripts/') && ASSIGNMENT.test(line)) {
        findings.push(`${rel}:${i + 1}  hard-coded credential assignment`);
      }
    });
  }
}

walk(ROOT);

// Project rules -----------------------------------------------------------
const example = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
for (const line of example.split(/\r?\n/)) {
  const m = /^([A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSPHRASE|URL)[A-Z0-9_]*)=(.+)$/.exec(line.trim());
  if (m) findings.push(`.env.example  ${m[1]} must be an empty placeholder`);
}
const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
for (const needed of ['.env', '.env.local', '.data/']) {
  if (!ignore.split(/\r?\n/).some((l) => l.trim() === needed)) findings.push(`.gitignore  missing rule for ${needed}`);
}
// NEXT_PUBLIC_ variables are shipped to the browser; none may look like a secret.
for (const file of ['.env.example']) {
  for (const line of fs.readFileSync(path.join(ROOT, file), 'utf8').split(/\r?\n/)) {
    if (/^NEXT_PUBLIC_[A-Z0-9_]*(KEY|SECRET|TOKEN|PASSWORD)/.test(line.trim())) findings.push(`${file}  browser-exposed variable looks like a secret: ${line.split('=')[0]}`);
  }
}

console.log(`secret-scan: ${scanned} files scanned, ${findings.length} finding(s)`);
if (findings.length > 0) {
  for (const f of findings) console.log(`  ${f}`);
  process.exit(1);
}
