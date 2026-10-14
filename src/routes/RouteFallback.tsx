import { isRouteErrorResponse, Link, useRouteError } from 'react-router-dom'

export function RouteNotFound() {
  return <main className="route-fallback" aria-labelledby="route-fallback-title">
    <span className="eyebrow">PAGE NOT FOUND</span>
    <h1 id="route-fallback-title">We couldn’t find that page</h1>
    <p>The address may have changed, or the page may no longer be available.</p>
    <Link className="button button-primary button-medium" to="/">Go to Today</Link>
  </main>
}

export function RouteErrorFallback() {
  const error = useRouteError()
  const notFound = isRouteErrorResponse(error) && error.status === 404
  return <main className="route-fallback" aria-labelledby="route-fallback-title">
    <span className="eyebrow">{notFound ? 'PAGE NOT FOUND' : 'PAGE UNAVAILABLE'}</span>
    <h1 id="route-fallback-title">{notFound ? 'We couldn’t find that page' : 'This page couldn’t load'}</h1>
    <p>{notFound ? 'The address may have changed, or the page may no longer be available.' : 'Please return to Today and try again.'}</p>
    <Link className="button button-primary button-medium" to="/">Go to Today</Link>
  </main>
}
