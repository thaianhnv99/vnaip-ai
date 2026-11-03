# Frontend native UI

## Native module model

A SotaAgents UI contribution is a React module loaded by the host, not an iframe
or standalone webpage. Export the exact named component declared in the
manifest. Do not mount a second application root, router, authentication flow,
or global design system.

## App UI declarations

Host APIs are typed through the CLI-pinned contract:

```ts
import { useAppFetch } from '@sota/platform';
```

The declarations live at `.sota/app-ui-contracts/current`, generated from bytes
embedded in the installed CLI. They are not normal npm dependencies and should
not be committed. Run:

```bash
sota contracts ensure
```

`sota init`, `sota add`, `sota dev`, build, and typecheck also repair this cache.
Use `sota update` to obtain a newer compatible contract snapshot. Never copy a
random remote `.d.ts` into the app: editor and build must agree on one pinned
contract.

For native composer panels and input editing, read
`composer-panels-and-input.md`. Those surfaces import `useComposer` from
`@sota/core/hooks`; it is intentionally unavailable to unrelated surfaces.

## Build configuration

The generated Vite config externalizes host-provided modules and emits stable
native module assets under `dist/ui`. Keep:

- React source in `src/ui`;
- locale source in `src/locales`;
- generated JavaScript and CSS in `dist/ui`;
- type path aliases pointed at `.sota/app-ui-contracts/current`.

Do not edit files under `dist` or `.sota`.

## Backend calls

Use the public bridge:

```tsx
const appFetch = useAppFetch();

useEffect(() => {
  void appFetch('/api/hello')
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    })
    .then(setData)
    .catch((error) => setError(String(error)));
}, [appFetch]);
```

Use relative app paths. Core resolves the active app installation and
environment, invokes the correct backend, and attaches the platform credential.
Do not hardcode local, Staging, Production, or private Core API URLs in UI code.

Handle loading, empty, success, and error states without throwing during render.
Abort or ignore stale requests when dependencies change.

## Host-safe styling

Scope CSS to the app root:

```tsx
export function AdminScreen() {
  return <section data-sota-app="my-app">{/* ... */}</section>;
}
```

```css
[data-sota-app='my-app'] {
  color: inherit;
}
```

Avoid unscoped element selectors, `:root` mutation, global resets, fixed viewport
overlays, and selectors that target host internals. Inherit typography and color
where possible. Design for the container supplied by the surface rather than
assuming a full browser viewport.

## Host components and icons

Prefer exports from the public `@sota/platform`, `@sota/platform/ui`, and
`@sota/platform/icons` contracts when available. Check generated declarations
instead of guessing names. Host imports must remain externalized; bundling a
second host component system can break contexts and inflate artifacts.

## Assets

Use immutable CDN or object-storage URLs for durable images and downloads when
the platform contract supplies them. Browser assets must be authorized for the
viewer and safe to cache. Avoid base64-encoding large documents or streaming
ordinary asset bytes through a custom proxy endpoint.

Keep small static UI assets inside the compiled app bundle. Do not expose a
private bucket URL or backend credential to the browser.

## Tool-result renderers

A tool renderer is final-only by default. Apps that need to visualize the tool
call while the model is still authoring its arguments may opt into the same
component being mounted before output. Read
`tool-input-streaming-surfaces.md` before enabling that lifecycle.

A final-only tool renderer should:

- tolerate missing optional fields and older results;
- render from structured output rather than reparsing prose;
- avoid repeating network work the tool already performed;
- keep model-only and renderer-only data separate;
- remain usable if the rich renderer cannot load.

## Accessibility and localization

- Use semantic controls, labels, focus states, and keyboard interaction.
- Do not encode status using color alone.
- Use locale resources for user-visible product strings.
- Format numbers, dates, and plural forms for the active locale.
- Keep errors actionable but do not expose internal stack traces or tokens.

## Performance

Keep initial modules small. Defer expensive views and data, memoize only where
measurement supports it, and avoid polling when the platform offers event-driven
updates. A native module should feel like part of the host: no duplicate splash
screen, auth redirect, or layout jump.
