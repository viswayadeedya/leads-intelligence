export default function Loading() {
  return (
    <div className="empty" role="status" aria-live="polite">
      <p className="empty-title">Loading…</p>
      <p>Reading stored data. Mock investigations finish within a few seconds; if this stays for longer, reload the page.</p>
    </div>
  );
}
