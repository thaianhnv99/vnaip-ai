# Backend and invocation authentication

## Backend contract

The app backend is framework-neutral HTTP. Use Express, Hono, Fastify, Python,
or another stack if it can:

- listen at the URL declared for the active environment;
- expose declared routes and methods;
- parse and return the documented JSON envelope;
- verify Core invocation credentials;
- respond within declared timeouts;
- expose a cheap health endpoint.

The generated scaffold uses Express for familiarity, not because the platform
requires Node.js or Express.

## Boundary order

For every non-health request:

1. Read the Bearer token.
2. Resolve the trusted Core JWKS from configured platform origin.
3. Verify EdDSA signature, `typ`, `kid`, issuer, audience/app id, and expiry.
4. Enforce short token lifetime and required endpoint scope.
5. Build a typed invocation context from verified claims.
6. Pass that context—not the raw token or body tenancy—to domain code.
7. Map known domain errors to stable HTTP/JSON responses.

Centralize these steps so individual handlers cannot accidentally skip them.

## Trusted identity

Depending on the endpoint, verified claims provide identifiers such as:

- app and installation;
- organization and workspace;
- actor/user;
- environment and execution generation;
- granted scopes.

Exact claim names and required values come from the current invocation contract.
Never accept a conflicting organization, workspace, installation, actor, scope,
or environment from body, query, path, cookie, or custom headers.

Actorless calls are legitimate for supported events/jobs and use the environment
recorded on their subscription. Do not invent a fake user or fall through to a
different environment. Make actor requirements explicit in domain operations
that truly need one.

## Core origin configuration

Use an explicit trusted Core origin in hosted environments. Local development
may default to a documented local/staging origin only when the scaffold says so.
Do not ship a hardcoded staging origin as a Production trust root. Cache JWKS
briefly and refresh safely on key rotation.

## Scopes

Each route should require the narrowest scope that authorizes its operation.
Reject missing or unexpected scope before executing domain work. If Core gives
the app a delegated token for a platform API, bind it to the verified app,
installation, organization, workspace, actor, and declared grants.

Do not let the caller request arbitrary scopes in a body field.

## HTTP behavior

- Validate request shape before domain work.
- Set input size limits.
- Return JSON for declared JSON routes.
- Use stable error codes/messages; keep stack traces in server logs.
- Return non-2xx for actual failures rather than a success-shaped error body.
- Respect abort signals and downstream timeouts.
- Make retried mutation routes idempotent when the invocation contract may retry.

## Health

`GET /health` should prove the process can serve requests. Keep it fast and avoid
performing expensive external calls on every poll. A liveness response normally
does not require an invocation JWT; readiness may check critical dependencies
with strict timeouts.

Do not expose config, credentials, tenant data, or stack traces.

## Logs

Use structured logs with:

- route/tool/event name;
- request or invocation id;
- verified installation/environment identifiers where allowed;
- duration and outcome;
- safe downstream status/error code.

Never log Bearer tokens, delegated tokens, secrets, full sensitive payloads, or
presigned URLs. Put enough context in one record to trace a call without joining
unbounded prose.

## Local backend

`sota dev` does not start the app backend. Run the app's watch command separately,
then start `sota dev`; the CLI health-checks and tunnels the declared local URL.
The generated full-stack project uses:

```bash
npm run dev
npm run dev:sota
```

The first command owns frontend/backend watches. The second owns only the
Development session and tunnel.
