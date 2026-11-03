# Architecture and project layout

## The simple mental model

A SotaAgents app contributes capabilities to Core. The app supplies:

- a strict manifest describing those capabilities;
- optional native UI modules;
- optional backend HTTP routes;
- optional static skill content and JSON Schemas.

Core supplies the difficult platform concerns:

- which organization, workspace, installation, app version, and environment is active;
- authentication and invocation credentials;
- agent/tool orchestration;
- host UI, routing, localization, and shared components;
- direct Production promotion, App Store governance, installation, and
  environment resolution.

The app should not create a parallel control plane for those concerns.

## Canonical generated layout

```text
.
├── .agent/
│   └── skills/
│       └── sotaagents-development-best-practices/
├── .sota/                       # generated local state; never commit
├── src/
│   ├── backend/                 # editable app backend
│   ├── locales/                 # editable locale JSON
│   ├── schemas/                 # editable JSON Schemas
│   ├── skills/                  # editable content-backed skills
│   └── ui/                      # editable native React UI
├── dist/                        # generated build output; never edit
├── AGENTS.md
├── CLAUDE.md
├── manifest.yaml
├── package.json
├── tsconfig.backend.json
├── tsconfig.ui.json
└── vite.config.ts
```

All source a developer edits belongs under `src/`. Build output belongs under
`dist/`. `.sota/` contains CLI-owned state such as the App UI type contract,
compiled artifacts, local session data, and bundles.

## Runtime independence

SotaAgents does not require a particular backend framework or package manager.
The default scaffold uses conventional TypeScript, Express, and npm-compatible
scripts because they are widely understood. Node.js, Bun, containers, or another
host may run the built HTTP service as long as it honors the manifest contract.

Do not put runtime-specific requirements into the manifest unless the manifest
schema explicitly defines them.

## Frontend and backend relationship

Native UI executes inside the SotaAgents host. It is not a separately deployed
website and it should not hardcode the app backend URL. Use the host bridge such
as `useAppFetch`; Core resolves the correct Development, Staging, or Production
backend and adds the correct invocation context.

The app backend is an ordinary HTTP service owned by the app developer. It:

- exposes the routes declared in the manifest;
- verifies the short-lived Core invocation token;
- performs app-specific domain work;
- stores app-specific data in its own backend or uses declared platform services.

## Dependency direction

Keep dependencies pointing inward:

```text
manifest -> built UI/backend routes
native UI -> @sota/platform public contract
backend boundary -> verified invocation context -> domain services
Core -> app backend declared route
```

Avoid importing Core implementation code, depending on private database shapes,
or duplicating environment resolution in the app.

## Choosing a capability

- Use a content skill for stable instructions or domain context.
- Use a dynamic skill route when content must be computed per invocation.
- Use a tool for an action or structured query the agent deliberately invokes.
- Use native UI for human interaction or rich rendering.
- Use a headless `composer-panel` for app-owned UI adjacent to the active input;
  let the panel decide its own visibility through `useComposer`.
- Use a backend only when the capability needs computation, private credentials,
  external APIs, durable domain data, or dynamic responses.
- Keep a blank manifest when the app truly contributes nothing yet; add recipes
  later with `sota add`.

## Design pressure

Prefer workflow-level tools that complete a meaningful user action. A large set
of tiny navigation or storage primitives increases agent planning cost and
failure modes. Keep internal primitives available to backend implementation,
but expose the smallest coherent agent-facing surface.
