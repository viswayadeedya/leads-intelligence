import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="empty">
      <h1>Not found</h1>
      <p>That page or record does not exist, or it is not yours to view.</p>
      <p>
        <Link className="btn-link btn-primary" href="/">
          Go to Home
        </Link>
      </p>
    </div>
  );
}
