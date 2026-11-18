import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { signOutAction } from './actions';
import { getConfig, getOptionalActor } from '@/lib/runtime';
import './globals.css';

export const metadata: Metadata = {
  title: 'Opportunity Intelligence (internal)',
  description: 'Evidence-first investigation of how customers find, contact and book a local business.',
  robots: { index: false, follow: false },
};

const NAV: { href: string; label: string }[] = [
  { href: '/', label: 'Home' },
  { href: '/discover', label: 'Discover' },
  { href: '/investigations', label: 'Investigations' },
  { href: '/evidence', label: 'Evidence' },
  { href: '/reports', label: 'Reports' },
  { href: '/outreach', label: 'Outreach' },
  { href: '/outcomes', label: 'Outcomes' },
  { href: '/settings', label: 'Settings' },
];

export default async function RootLayout({ children }: { children: ReactNode }) {
  const actor = await getOptionalActor();
  const config = getConfig();
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <div className="mock-bar" role="note">
          <strong>MOCK MODE.</strong> Website checks use fictional, synthetic fixtures. Nothing here is evidence about a real company, and nothing is sent anywhere.
        </div>
        {config.liveRequested ? (
          <div className="config-bar" role="alert">
            Live mode was requested in the environment, but this build cannot run live: the release gates have not passed. It is running in mock mode.
          </div>
        ) : null}
        {actor ? (
          <div className="site-header">
            <div className="site-header-inner">
              <Link className="brand" href="/">
                Opportunity Intelligence
              </Link>
              <nav className="main-nav" aria-label="Main">
                <ul>
                  {NAV.map((item) => (
                    <li key={item.href}>
                      <Link href={item.href}>{item.label}</Link>
                    </li>
                  ))}
                </ul>
              </nav>
              <span className="header-spacer" />
              <form action={signOutAction} className="signout">
                <button type="submit">Sign out</button>
              </form>
            </div>
          </div>
        ) : null}
        <main id="main">{children}</main>
      </body>
    </html>
  );
}
