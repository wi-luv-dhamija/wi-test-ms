import { Link } from 'react-router';

export function NotFoundPage() {
  return (
    <>
      <div className="page-header">
        <h1>Page not found</h1>
      </div>
      <Link to="/">Back to dashboard</Link>
    </>
  );
}
