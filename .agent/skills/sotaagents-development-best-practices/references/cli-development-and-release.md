# CLI development and release

## Install and update

```bash
sota --version
sota update
sota update skills
sota config set-origin https://your-platform.example
sota login
```

`sota update` updates the installed CLI binary. Run `sota update skills` from
inside an app project after that to create or refresh the embedded development
skill bundle. The skills update overwrites only files whose previous exact hash
was CLI-owned, preserves developer-modified and unknown files, removes retired
files only when their owned hash still matches, and repairs the required
`AGENTS.md`/`CLAUDE.md` guidance block.

The platform web origin may be supplied when discovery is configured; the CLI
resolves the matching API origin. If discovery fails, inspect the platform
discovery endpoint and configured origin before changing app code.

## Create and extend

```bash
sota init my-app
sota init my-app --features all
sota add admin-screen
sota add backend tool
```

`init`, `add`, and `update skills` use the same embedded skill source and safe
ownership rules. They preserve existing user files and report collisions
instead of silently replacing custom code.
Source stays in `src`; generated output stays in `dist` and `.sota`.

## Type contracts

The CLI embeds a versioned public App UI declaration snapshot. These commands
materialize or repair `.sota/app-ui-contracts/current`:

```bash
sota contracts ensure
sota dev
sota build
sota typecheck
```

`init` and `add` do so as well. The snapshot moves forward when the CLI is
updated; it does not mutate from an uncontrolled remote fetch. Never commit
`.sota`.

## Validate and build

```bash
npm run typecheck
npm run build
sota validate
sota build
```

The app owns its build scripts. `sota build` packages existing outputs; it does
not replace the frontend/backend build. Build source first, then package.

The compiler validates, applies environment bindings, inlines static contribution
content, and traces native assets. Do not hand-author compiler-derived integrity,
`requires`, or resolved schema fields.

## Development

Development is personal, session-bound, and uses the local app process:

```bash
# terminal 1: app-owned backend/UI watches
npm run dev

# terminal 2: manifest sync + local backend tunnel
npm run dev:sota
# equivalent: sota dev
```

The CLI resolves the workspace, prepares manifest and frontend outputs, verifies
the local service/tunnel, then commits the Development session. Stop with:

```bash
sota dev stop
```

When the session ends, the Development app disappears. A local process by itself
does not publish a Development card.

## Staging

```bash
sota deploy
```

Deploy creates or replaces the Staging app using hosted artifacts and the hosted
backend configured for that environment. It must not depend on a local tunnel.
The Staging app remains until replaced or deleted.

## Production

```bash
sota release
```

Release promotes the exact Staging artifact directly to Production. A newer
Staging deploy never changes Production until `sota release` runs again.

The first Production promotion initializes `private`. Later promotions preserve
the current `private | restricted | public` visibility and any App Store
eligibility grant. App Store review is a separate owner submission and System
Admin decision; it is never a gate on Production.

## Command mapping

```text
sota dev      -> Development -> local service through tunnel
sota deploy   -> Staging     -> hosted service/artifact
sota release  -> Production  -> current tested Staging artifact
```

All three environments have the same app capability model. They differ by how
Core resolves the environment instance, artifact, and backend—not by app-side
feature restrictions.

## Before deploy or release

1. Build and typecheck app-owned source.
2. Run `sota validate`.
3. Commit the exact source/artifact provenance expected by the team workflow.
4. Deploy and smoke Staging.
5. Release only the artifact actually tested in Staging.

Avoid automatic version bumps before validation/build; a failed build should not
consume an app version.
