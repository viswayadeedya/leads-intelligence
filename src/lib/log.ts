// Structured logs. Secrets, cookies, headers and source bodies must never be
// logged; redact() is applied to every field as a second line of defense.

const SENSITIVE_KEY = /(token|secret|cookie|authorization|password|passphrase|credential|key|session|body|html|excerpt)/i;
const MAX_STRING = 200;

export function redact(value: unknown, key = '', depth = 0): unknown {
  if (key && SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[truncated]` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= 4) return '[depth-limited]';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, key, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redact(v, k, depth + 1);
    }
    return out;
  }
  return '[unsupported]';
}

export type LogFields = {
  action: string;
  result: 'ok' | 'rejected' | 'error';
  actor?: string;
  runId?: string;
  adapter?: string;
  durationMs?: number;
  costCents?: number;
  [extra: string]: unknown;
};

export function logEvent(fields: LogFields, sink: (line: string) => void = defaultSink): void {
  const safe = redact({ at: new Date().toISOString(), ...fields }) as Record<string, unknown>;
  sink(JSON.stringify(safe));
}

function defaultSink(line: string): void {
  if (process.env.NODE_ENV === 'test' || process.env.VITEST) return;
  console.log(line);
}
