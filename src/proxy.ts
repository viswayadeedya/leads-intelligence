import { NextResponse, type NextRequest } from 'next/server';
import { buildCsp, isPublicPath, isSameOrigin, isStateChanging } from '@/lib/security/origin';

const SESSION_COOKIE = 'oi_session';

// Runs before every route. It is a first gate only: each page, action and API
// route validates the session again against the server-side session store.
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isStateChanging(request.method) && !isSameOrigin(request.headers.get('origin'), request.headers.get('host'))) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'forbidden', message: 'Cross-origin request refused.' }, { status: 403 });
    }
    // A person submitting a form should get a readable page, not raw JSON.
    return new NextResponse(
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Request refused</title></head><body style="font-family:system-ui;max-width:40rem;margin:3rem auto;padding:0 1rem">' +
        '<h1>Request refused</h1><p>This form was not submitted from this app, or the browser did not say where it came from, so nothing was changed.</p>' +
        '<p>Go back, reload the page, and try again.</p><p><a href="/">Go to Home</a></p></body></html>',
      { status: 403, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'", 'Cache-Control': 'no-store' } },
    );
  }

  if (!request.cookies.has(SESSION_COOKIE) && !isPublicPath(pathname)) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'unauthenticated', message: 'Sign in first.' }, { status: 401 });
    }
    return NextResponse.redirect(new URL('/login', request.url));
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const csp = buildCsp(nonce, process.env.NODE_ENV !== 'production');
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
