// Non-secret configuration. Secret VALUES are never returned from here; only
// whether a credential is configured, so Settings can show health without values.

export type AppConfig = {
  /** This build only runs in mock mode. Live mode is gated (see docs/security). */
  mode: 'mock';
  liveRequested: boolean;
  /**
   * Second lock on live website fetching. `loadConfig` ALWAYS returns false:
   * there is deliberately no environment variable for it. Only tests that run
   * against controlled servers on this machine set it, in memory.
   */
  liveFetchUnlocked: boolean;
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
  /** a session ends after this long without a request, whatever its absolute limit */
  sessionIdleMinutes: number;
  maxSessions: number;
  /** Host header values this app answers to. Anything else is refused (DNS-rebinding defense). */
  allowedHosts: string[];
  approvalTtlMinutes: number;
  dataDir: string;
  credentials: { name: string; configured: boolean }[];
  /** OPERATOR_PASSPHRASE is present in the environment (its value is never exposed here) */
  envPassphraseSet: boolean;
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
    liveFetchUnlocked: false,
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
    sessionIdleMinutes: intFromEnv(env.SESSION_IDLE_MINUTES, 60, 5, 1440),
    maxSessions: intFromEnv(env.MAX_SESSIONS, 5, 1, 20),
    allowedHosts: ['localhost', '127.0.0.1', '[::1]', ...(env.OI_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter((h) => /^[a-z0-9.-]{1,253}$/.test(h))],
    approvalTtlMinutes: intFromEnv(env.APPROVAL_TTL_MINUTES, 60, 1, 1440),
    dataDir: env.OI_DATA_DIR && env.OI_DATA_DIR.trim() !== '' ? env.OI_DATA_DIR : '.data',
    credentials: CREDENTIAL_NAMES.map((name) => ({
      name,
      configured: Boolean(env[name] && env[name]!.trim() !== ''),
    })),
    envPassphraseSet: Boolean(env.OPERATOR_PASSPHRASE && env.OPERATOR_PASSPHRASE.length > 0),
  };
}
