# Google sign-in

Mohr supports optional **Continue with Google** sign-in through Google OpenID
Connect (authorization-code flow, `openid email` scope). It is disabled by
default and changes nothing about password sign-in when it is off.

## Configuration

Set these server-side environment variables on the deployed service:

| Variable | Required | Meaning |
| --- | --- | --- |
| `GOOGLE_AUTH_ENABLED` | no (default `False`) | Enables the feature. |
| `GOOGLE_CLIENT_ID` | when enabled | OAuth client ID from the Google Cloud console. |
| `GOOGLE_CLIENT_SECRET` | when enabled | OAuth client secret; never sent to the browser. |
| `GOOGLE_REDIRECT_URI` | when enabled | Must be an absolute URL whose exact path is `/api/auth/google/callback/` and match an authorized redirect URI in Google. |

When `GOOGLE_AUTH_ENABLED` is set, Django fails to start unless the client
ID and secret are non-empty, the redirect URI has no surrounding whitespace,
userinfo, query, or fragment, its exact path is `/api/auth/google/callback/`,
its port (if present) is valid, and the session engine is the default database
engine. In production the redirect URI must use `https` and its host must be
one of `DJANGO_ALLOWED_HOSTS`; outside production an `http://localhost` or
`http://127.0.0.1` redirect is allowed for a real local dev client.

The operator creates the Google OAuth client and its consent screen in the
Google Cloud console. Mohr ships no provider credentials and cannot complete
a real Google sign-in without that operator setup.

## Flow

1. The login screen reads `GET /api/auth/google/config/` and shows the button
   only when the feature is enabled.
2. `POST /api/auth/google/start/` (CSRF-protected, also for anonymous
   callers) accepts an `intent` of `sign-in` or `link` and an optional `next`
   from Mohr's own private paths. It stores a one-time `state`, `nonce`,
   intended destination, and (for linking) the current actor in the database
   session, then returns the fixed Google authorization URL.
3. Google redirects back to `GET /api/auth/google/callback/` with a one-time
   `code` and the `state`.
4. The callback atomically claims and deletes the stored flow from the locked
   session row **before** any network call, then exchanges the code, fetches
   Google's JWKS, and verifies the RS256 ID token against the fixed Google
   endpoints. The nonce, exact audience (a single string equal to the app's
   client ID, not an array merely containing it), issuer allowlist, integer
   `iat`/`exp`, subject, and a literal `email_verified == true` are all
   required; when Google includes an `azp`, it must be that same client ID.
5. The verified subject is resolved:

   - A known subject signs the existing active user in.
   - An unknown subject with no local email creates a local user with an
     unusable password and stores the subject.
   - An unknown subject whose email already exists is **not** merged. The
     browser is sent to `/login?google=link-required` and the owner must sign
     in with their password and explicitly link Google.

6. The response is a fixed internal redirect (success destination or
   `/login?google=failed` / `/login?google=link-required`) with
   `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.

## Security properties

- Google identity is resolved by the stable `sub` claim only. No identity is
  ever keyed on an unverified email.
- Email addresses are never merged automatically between a password account
  and a Google account.
- Linking refuses a subject already owned by another user and refuses to
  replace an existing different subject; the primary email and financial
  owner never change. The actor is re-authenticated through Django's session
  hash check after the flow claims the session, so a password change during
  consent invalidates the link even if the old database session survives.
- An intentional link reloads and locks the actor inside a transaction before
  writing `google_sub`, so a stale in-memory actor cannot overwrite a link made
  while consent was in flight.
- The one-use flow lives in the platform database session and is claimed once
  under a row lock. Replays, expired flows, deleted sessions, and changed
  link actors fail closed and never resurrect a logged-out session.
- Provider tokens are never stored, and no code, state, token, provider body,
  claim, or secret is logged or returned to the browser.
- Gunicorn access logs record the request path but not the query string, so
  transient callback parameters never reach deployed logs.
