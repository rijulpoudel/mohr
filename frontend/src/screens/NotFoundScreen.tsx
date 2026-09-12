import { Link } from 'react-router-dom'

export function NotFoundScreen() {
  return (
    <div className="screen">
      <h2>Page not found</h2>
      <p>The page you requested does not exist.</p>
      <Link className="btn" to="/">
        Back to Mohr
      </Link>
    </div>
  )
}