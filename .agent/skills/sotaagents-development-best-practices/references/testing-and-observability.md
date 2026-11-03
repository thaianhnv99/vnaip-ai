# Testing and observability

## Test by contract boundary

Spend tests where the platform/app boundary can fail:

- manifest schema and cross-field validation;
- invocation token verification and endpoint scopes;
- tenant/environment filtering;
- route input/output schemas;
- native module exports and host imports;
- composer panel presence, slash independence, and structured edits;
- build outputs referenced by the manifest;
- environment resolution across Development, Staging, and Production.

Framework internals need less testing than app-specific domain behavior and
authorization.

For native UI, the manifest `module.export` must be a real key of the entry
module's exported `surfaces` object. `sota validate` checks this against the
built bundle, so an export-name mismatch is a preflight failure rather than a
runtime fallback.

## Minimal local loop

```bash
sota contracts ensure
npm run typecheck
npm run build
sota validate
```

Then run app watches and `sota dev`. Verify:

- Development card appears for the selected workspace;
- native UI renders without fallback flicker;
- one FE-to-BE call reaches the local backend;
- one declared tool succeeds with verified context;
- a composer panel appears only under its app-owned condition, and its edit
  preserves or replaces existing input according to the chosen mode;
- `sota dev stop` removes the Development app.

## Staging smoke

After `sota deploy`:

- Staging card exists with the Staging chip;
- UI loads the hosted artifact;
- backend requests use the hosted service without a tunnel;
- health is good;
- read and mutation paths hit only Staging data;
- no HTTP 500/502 appears in the normal flow.

## Production smoke

After `sota release`:

- the Production promotion references the intended artifact id/version;
- Production card and visibility are correct;
- Production runs the pinned artifact, even if Staging later changes;
- Production data and callbacks stay isolated from Staging;
- rollback/recovery behavior is understood before risky release.

## Logs

Inspect frontend host, Core/API, app backend, and worker logs for the exact test
window. Correlate by request/session/job ids. A green UI toast is not sufficient
if the initiating HTTP request returned an error or a background job failed.

For each app backend request, log:

- safe invocation/request id;
- endpoint/capability;
- verified environment and tenant identifiers where policy permits;
- duration;
- downstream status;
- stable error code.

## Error design

Use stable machine-readable error codes and short user-safe messages. Include
retry guidance only when retry is safe. Preserve detailed causes in redacted
server logs. A tool should not report success when the authoritative operation
failed.

## Regression matrix

At minimum cover:

| Surface   | Success               | Expected failure                          |
| --------- | --------------------- | ----------------------------------------- |
| Manifest  | valid app compiles    | unknown/missing field rejected            |
| Auth      | correct token/scope   | wrong audience, expired, missing scope    |
| Tenancy   | own workspace data    | cross-workspace id denied                 |
| Tool      | schema-valid response | invalid input and backend error           |
| Native UI | declared export loads | missing host type/export caught           |
| Composer  | panel edits one draft | `return null` stays absent; no false arrows |
| Files     | authorized URL works  | expired/foreign URL denied                |
| Job       | start then complete   | retry/idempotency and revoked environment |

## Release checklist

- Source, generated outputs, and manifest refer to the same version.
- No `.invalid`, localhost, secret, or private bucket endpoint in hosted config.
- `.sota` and `dist` are treated according to repository policy.
- Schemas are strict enough for the actual tool contract.
- Tool descriptions and skills match current behavior.
- `sota validate`, typecheck, and build pass.
- Staging smoke uses hosted backend.
- Release pins the artifact actually tested in Staging.
- Logs show no unexpected 4xx/5xx in the test window.
