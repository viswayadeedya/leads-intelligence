import type { NextConfig } from 'next';

// Static security headers. The Content-Security-Policy is set per request in
// src/proxy.ts because it carries a nonce.
const nextConfig: NextConfig = {
  poweredByHeader: false,
  productionBrowserSourceMaps: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          // same-origin, not no-referrer: with no-referrer browsers send "Origin: null" on
          // plain HTML form posts, which the CSRF origin check then (correctly) refuses.
          // Nothing is sent to other sites either way.
          { key: 'Referrer-Policy', value: 'same-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
