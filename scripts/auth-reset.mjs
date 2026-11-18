// Removes the operator passphrase, any pending setup code, every session and
// the failed-attempt counter from the local data file. Research data is kept.
// The next visit to the sign-in page starts setup again with a new code.
//
// Running this needs access to the project folder on this computer, which is
// the same level of access that reading the setup code needs.
//
// Usage: stop the app first, then: node scripts/auth-reset.mjs
import fs from 'node:fs';
import path from 'node:path';

const dataDir = process.env.OI_DATA_DIR && process.env.OI_DATA_DIR.trim() !== '' ? process.env.OI_DATA_DIR : '.data';
const file = path.resolve(dataDir, 'db.json');
const codeFile = path.resolve(dataDir, 'setup-code.txt');

fs.rmSync(codeFile, { force: true });
if (!fs.existsSync(file)) {
  console.log(`auth-reset: no data file at ${path.join(dataDir, 'db.json')}; nothing to reset.`);
  process.exit(0);
}
const db = JSON.parse(fs.readFileSync(file, 'utf8'));
const sessions = Array.isArray(db.sessions) ? db.sessions.length : 0;
const hadCredential = Boolean(db.auth && db.auth.credential);
db.auth = { credential: null, setup: null };
db.sessions = [];
db.loginAttempts = [];
if (Array.isArray(db.auditEvents)) {
  db.auditEvents.push({
    id: `aud_reset-${Date.now()}`,
    ownerId: 'usr_local-operator',
    actorKind: 'system',
    action: 'auth.reset_from_command_line',
    targetType: 'user',
    targetId: 'usr_local-operator',
    detail: 'Passphrase and sessions removed with the auth-reset script.',
    at: new Date().toISOString(),
  });
}
const tmp = `${file}.${process.pid}.tmp`;
fs.writeFileSync(tmp, JSON.stringify(db), { encoding: 'utf8', mode: 0o600 });
fs.renameSync(tmp, file);
console.log(`auth-reset: ${hadCredential ? 'passphrase removed' : 'no passphrase was stored'}; ${sessions} session(s) ended. Research data was not touched.`);
console.log('auth-reset: open the sign-in page to set a new passphrase.');
