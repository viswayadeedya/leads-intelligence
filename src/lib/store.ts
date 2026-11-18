// Persistence boundary. Mock mode uses a local JSON file (no credentials needed).
// The Supabase/Postgres schema in supabase/migrations mirrors these collections;
// swapping the Store implementation is the planned path to a hosted database.
//
// All mutations go through transact(): read -> mutate -> atomic write. There are
// no awaits inside a transaction, so within one Node process it is atomic.

import fs from 'node:fs';
import path from 'node:path';
import { type Db, emptyDb } from './types';

export interface Store {
  /** Returns a private copy; mutating it does not change stored data. */
  snapshot(): Db;
  transact<T>(fn: (db: Db) => T): T;
}

export class MemoryStore implements Store {
  private db: Db = emptyDb();
  snapshot(): Db {
    return structuredClone(this.db);
  }
  transact<T>(fn: (db: Db) => T): T {
    const working = structuredClone(this.db);
    const result = fn(working);
    this.db = working;
    return result;
  }
}

export class JsonFileStore implements Store {
  private readonly file: string;
  constructor(dataDir: string) {
    this.file = path.resolve(dataDir, 'db.json');
  }

  private load(): Db {
    if (!fs.existsSync(this.file)) return emptyDb();
    const raw = fs.readFileSync(this.file, 'utf8');
    const parsed = JSON.parse(raw) as Partial<Db>;
    // Tolerate collections added in later versions.
    return { ...emptyDb(), ...parsed };
  }

  private save(db: Db): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db), { encoding: 'utf8', mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmp, this.file);
        return;
      } catch (e) {
        // Windows can briefly hold the destination open (indexer/antivirus).
        if (attempt >= 5) {
          fs.rmSync(tmp, { force: true });
          throw e;
        }
      }
    }
  }

  snapshot(): Db {
    return this.load();
  }

  transact<T>(fn: (db: Db) => T): T {
    const db = this.load();
    const result = fn(db);
    this.save(db);
    return result;
  }
}
