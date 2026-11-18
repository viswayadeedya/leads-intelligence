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

/**
 * DNS-rebinding defense for the app itself. A page on another site can point
 * its own hostname at 127.0.0.1 and then talk to this server "same-origin";
 * its requests still carry that hostname in the Host header, so only known
 * hostnames are answered. The port is ignored; the name must match exactly.
 */
export function isAllowedHost(hostHeader: string | null, allowed: readonly string[]): boolean {
  if (!hostHeader) return false;
  const value = hostHeader.trim().toLowerCase();
  if (value === '' || value.length > 270 || /[\s/@\\?#]/.test(value)) return false;
  let host = value;
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end === -1) return false;
    const rest = value.slice(end + 1);
    if (rest !== '' && !/^:\d{1,5}$/.test(rest)) return false;
    host = value.slice(0, end + 1);
  } else {
    const parts = value.split(':');
    if (parts.length > 2) return false;
    if (parts.length === 2 && !/^\d{1,5}$/.test(parts[1]!)) return false;
    host = parts[0]!;
  }
  return allowed.includes(host);
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
