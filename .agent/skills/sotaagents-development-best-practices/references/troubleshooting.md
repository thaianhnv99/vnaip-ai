# Troubleshooting

## `Cannot find module '@sota/platform'`

The host type contract has not been materialized or the editor has not reloaded
the project:

```bash
sota contracts ensure
npm run typecheck
```

Confirm `.sota/app-ui-contracts/current/types/platform.d.ts` exists and the UI
tsconfig maps `@sota/platform` to the generated declarations. Do not add a fake
npm dependency or hand-written ambient module. Update the CLI when a newer host
contract is required.

## Development platform discovery fails

Check:

```bash
sota config get-origin
sota config set-origin https://platform-web-origin.example
sota login
```

The platform must publish working discovery from web origin to API origin. A
failure here is platform/discovery configuration, not an app manifest problem.

## `manifest must be an object`

Confirm the CLI sends a parsed object in the current manifest dialect expected
by the selected Core. Run `sota update`, inspect `sota --version`, then
`sota validate`. Do not stringify an already parsed manifest in custom code.

## Composer panel does not appear

- Run `sota update`, then `sota contracts ensure` and `sota update skills`.
- Declare `surface: composer-panel` with `slot: chat.composer.panel`.
- Export the exact component named by `module.export` from `surfaces`.
- Import `useComposer` from `@sota/core/hooks` only inside that panel.
- If the component returns `null`, uses `display: none`, or has zero normal-flow
  size, Core correctly treats it as absent.
- For a local slash trigger, declare a separate command with
  `mode: insert-only`; do not point its `target` at the panel.

If clicking a template removes the old draft, inspect the app's edit mode.
`replace` intentionally replaces everything. Use `append`, `insert-at-cursor`,
or rebuild `content` from the current structured nodes.

## Local backend unavailable

- Start the app-owned backend/watch command.
- Confirm `environments.local.service.baseUrl`.
- Request the local health URL directly.
- Ensure the process listens on the same host/port.
- Then restart `sota dev`.

`sota dev` tunnels an existing service; it does not start it.

## HTTP 401 or 403

Inspect backend logs for the stable verification reason:

- missing Bearer token;
- wrong `typ`, issuer, audience, or key id;
- expired/excessive TTL;
- wrong installation/environment;
- missing endpoint scope.

Do not disable verification. Confirm platform and app configuration agree.

## HTTP 502 in Development

Check local service health and the active tunnel first. Stop stale sessions and
start one clean session. If the UI alternates between app and fallback, correlate
host/API/tunnel logs; avoid adding retries that continually remount the module.

## UI alternates between custom app and fallback

Likely causes:

- unstable manifest/asset revision during watch;
- a native asset request intermittently fails;
- module export throws during render;
- Development tunnel/session reconnect replaces state;
- host resolver receives conflicting environment state.

Check browser network/console and exact API/FE logs. Keep the last known good
module mounted during a transient refresh where the host contract supports it.

## Upload appears failed but records exist

Treat HTTP 500 as failure even if a partial record was created. Inspect app
backend/worker logs and record state. Make the initiating route atomic or return
an accepted job response before asynchronous work. Retry must be idempotent.

## Hosted app still calls localhost

Localhost escaped into the base manifest or frontend code. Move service/health
overrides to `environments.local`, use relative `useAppFetch` paths, rebuild,
validate, and redeploy.

## Native asset or icon does not render

- Confirm the manifest points to built `dist` files.
- Verify Vite externalization and relative base.
- Check exact external origin declarations for remote assets.
- Prefer a CDN/storage URL over an app byte-stream proxy.
- Confirm viewer authorization and URL expiry.

## Exact count is wrong

Top-k semantic retrieval is not exhaustive. Use a deterministic documents query
or analysis workflow that enumerates the authoritative index, reports inspected
and matched counts, and states truncation/completeness.

## Staging works, Production differs

Compare pinned artifact ids, manifest versions, hosted backend URLs, environment
data, grants, and the promotion record. Production must run the explicitly
promoted artifact; do not assume it follows the newest Staging deploy.

## Before applying a workaround

1. Reproduce with the smallest command/request.
2. Capture exact status, route, environment, artifact, and log window.
3. Identify whether failure is app source, CLI compile, Core resolution, tunnel,
   hosted backend, or host rendering.
4. Fix the owning boundary.
5. Re-run the same minimal reproduction and normal happy path.
