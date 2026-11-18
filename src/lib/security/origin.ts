// CSRF defense in depth for cookie-authenticated, state-changing requests:
// the Origin header must be present and match the host being addressed.
// (The session cookie is also SameSite=Strict, and Next.js Server Actions
// perform their own Origin check.)

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isStateChanging(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}

export function isSameOrigin(originHeader: string | null, hostHeader: string | null): boolean {
  if (!originHeader || !hostHeader) return false;
  if (originHeader === 'null') return false;
  let origin: URL;
  try {
    origin = new URL(originHeader);
  } catch {
    return false;
  }
  if (origin.protocol !== 'http:' && origin.protocol !== 'https:') return false;
  return origin.host.toLowerCase() === hostHeader.trim().toLowerCase();
}

const PUBLIC_PATHS = ['/login'];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.includes(pathname);
}

export function buildCsp(nonce: string, isDev: boolean): string {
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    // Dev tooling injects inline styles; production allows only nonce'd styles.
    isDev ? "style-src 'self' 'unsafe-inline'" : `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data:",
    "font-src 'self'",
    isDev ? "connect-src 'self' ws: wss:" : "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  if (!isDev) directives.push('upgrade-insecure-requests');
  return directives.join('; ');
}
