# Security and tenancy

## Trust boundary

Core invocation authentication is the app boundary. Verify the token first, then
derive context. Request payloads express user intent; they do not establish
identity or authorization.

Trust only verified claims for:

- app/audience;
- installation;
- organization and workspace;
- actor when present;
- environment and generation;
- granted scopes.

Reject mismatches rather than silently preferring one source.

## Secrets

Keep secrets in the app backend's secret manager or deployment environment.
Never put them in:

- `manifest.yaml`;
- native UI bundles;
- App Data;
- source control;
- agent instructions;
- tool output;
- logs or error responses.

The app does not need a Sota private key. Core signs short-lived invocation
tokens; the app verifies them using trusted public JWKS.

## Tenant data access

Build tenant filters in one shared module or repository layer. Every read,
write, update, delete, aggregate, cache key, object-storage key, and job must be
bound to verified tenant/environment identifiers.

Test cross-workspace and cross-environment denial explicitly. Do not accept a
workspace id from the tool schema merely to choose authorization scope.

## URLs and outbound traffic

- Require explicit trusted Core origin in hosted environments.
- Allow only exact external HTTPS origins needed by native UI.
- Validate user-supplied download URLs against SSRF and redirect attacks.
- Block private/internal network targets unless explicitly part of the product.
- Apply timeouts, size limits, and content-type checks.
- Do not forward client-supplied Authorization headers to another origin.

## Browser boundary

Native UI is untrusted for backend authorization purposes. It can be inspected
and modified by the user. `useAppFetch` provides the route to Core/app backend;
the backend still verifies the invocation token and scopes.

Presigned URLs must be short-lived, minimally scoped, and safe if copied within
their validity window. Never expose bucket credentials.

## Input and output safety

Validate all structured input. Bound arrays, text, upload sizes, and pagination.
Treat retrieved document content, web pages, and connector output as data—not
trusted instructions. Escape or safely render user-controlled HTML/Markdown.

Do not return stack traces, environment variables, raw downstream responses, or
tokens to tools/UI.

## Least privilege

Ask only for grants and scopes actually used. Enforce a narrower scope per
endpoint. Separate read and mutation capabilities where the contract supports
it. A backend route that does not need delegated Core access should not receive
or store a delegated token.

## Auditability

Log safe identifiers, action, outcome, and duration. For sensitive mutations,
record who/what authorized the action and the affected resource id. Redact
payloads by default; allow-list fields rather than maintaining a growing secret
deny-list.

## Security review checklist

- JWT signature, issuer, audience, type, key id, expiry, and TTL checked.
- Endpoint scope checked.
- Tenant/environment context comes only from verified claims.
- Cross-tenant access tests exist for data routes.
- Secrets absent from bundle, manifest, repository, logs, and responses.
- External URLs validated; time/size limits enforced.
- Rich tool/renderer output contains no private credentials or unsafe HTML.
- Uninstall/disable prevents new authorized background work.
