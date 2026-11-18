// Non-secret configuration. Secret VALUES are never returned from here; only
// whether a credential is configured, so Settings can show health without values.

export type AppConfig = {
  /** This build only runs in mock mode. Live mode is gated (see docs/security). */
  mode: 'mock';
  liveRequested: boolean;
  maxCostCents: number;
  maxRequests: number;
  maxPagesPerSite: number;
  maxRetries: number;
  maxRunsPerHour: number;
  maxResponseBytes: number;
  fetchTimeoutMs: number;
  maxRedirects: number;
  staleAfterDays: number;
  sessionTtlMinutes: number;
  approvalTtlMinutes: number;
  dataDir: string;
  credentials: { name: string; configured: boolean }[];
  operatorPassphraseSet: boolean;
};

function intFromEnv(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

const CREDENTIAL_NAMES = [
  'DATABASE_URL',
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'GOOGLE_PLACES_API_KEY',
  'LLM_API_KEY',
];

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const requested = (env.APP_MODE ?? env.NEXT_PUBLIC_APP_MODE ?? 'mock').trim().toLowerCase();
  return {
    mode: 'mock',
    liveRequested: requested === 'live',
    maxCostCents: intFromEnv(env.MAX_INVESTIGATION_COST_CENTS, 50, 0, 10_000),
    maxRequests: intFromEnv(env.MAX_INVESTIGATION_REQUESTS, 30, 1, 200),
    maxPagesPerSite: intFromEnv(env.MAX_PAGES_PER_SITE, 5, 1, 20),
    maxRetries: intFromEnv(env.MAX_RETRIES_PER_RUN, 2, 0, 5),
    maxRunsPerHour: intFromEnv(env.MAX_RUNS_PER_HOUR, 20, 1, 500),
    maxResponseBytes: intFromEnv(env.MAX_RESPONSE_BYTES, 1_000_000, 1_000, 5_000_000),
    fetchTimeoutMs: intFromEnv(env.FETCH_TIMEOUT_MS, 10_000, 500, 60_000),
    maxRedirects: intFromEnv(env.MAX_REDIRECTS, 3, 0, 5),
    staleAfterDays: intFromEnv(env.STALE_AFTER_DAYS, 180, 1, 3650),
    sessionTtlMinutes: intFromEnv(env.SESSION_TTL_MINUTES, 480, 5, 1440),
    approvalTtlMinutes: intFromEnv(env.APPROVAL_TTL_MINUTES, 60, 1, 1440),
    dataDir: env.OI_DATA_DIR && env.OI_DATA_DIR.trim() !== '' ? env.OI_DATA_DIR : '.data',
    credentials: CREDENTIAL_NAMES.map((name) => ({
      name,
      configured: Boolean(env[name] && env[name]!.trim() !== ''),
    })),
    operatorPassphraseSet: Boolean(env.OPERATOR_PASSPHRASE && env.OPERATOR_PASSPHRASE.length > 0),
  };
}
