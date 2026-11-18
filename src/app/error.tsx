'use client';

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="empty" role="alert">
      <h1>This page could not be shown</h1>
      <p>An unexpected error stopped the page from loading. Nothing was sent, approved or deleted by this failure.</p>
      <p>Try again. If it keeps happening, check the terminal where the app is running{error.digest ? ` and look for reference ${error.digest}` : ''}.</p>
      <button type="button" className="btn-primary" onClick={() => reset()}>
        Try again
      </button>
    </div>
  );
}
