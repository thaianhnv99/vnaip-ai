---
name: sotaagents-development-best-practices
description: Build, change, debug, and release SotaAgents manifest-v3 apps. Use for every task in this app, especially manifest contributions, native React UI, app backends, tools, skills, events, App Data, files, CLI development flow, validation, deploy, and release.
---

# SotaAgents development best practices

Always use this skill before planning or editing this app.

## Working method

1. Inspect `manifest.yaml`, `package.json`, the relevant source files, and current CLI output before changing code.
2. Run `sota contracts ensure` before editing native UI when editor types are absent or stale.
3. Read only the reference files relevant to the task using the routing table below.
4. Treat the current manifest schema, compiler diagnostics, generated type declarations, and CLI help as authoritative. Examples in this skill explain the contract; they do not override it.
5. Keep platform responsibilities in Core and app responsibilities in the app. Do not reproduce tenancy, install resolution, environment selection, credential minting, or host UI behavior in app code.
6. Preserve user-owned files. Prefer focused changes and existing project conventions.
7. Run the smallest relevant checks while iterating, then `sota validate` and the app build before handing off.

## Reference routing

- Project shape and responsibility boundaries: `references/architecture-and-project-layout.md`
- Manifest v3 fields, contributions, environments, and common validation failures: `references/manifest.md`
- Native React UI, host imports, styling, assets, and FE-to-BE calls: `references/frontend-native-ui.md`
- Tool surfaces that render while the model streams tool input: `references/tool-input-streaming-surfaces.md`
- Composer panels, `useComposer`, slash triggers, edits, and app references: `references/composer-panels-and-input.md`
- Backend endpoints, invocation JWT/JWKS verification, errors, and health: `references/backend-and-auth.md`
- Tools, schemas, model-visible output, renderers, and skills: `references/tools-skills-and-agent-design.md`
- CLI commands and the Development → Staging → Production lifecycle: `references/cli-development-and-release.md`
- App Data, files, events, jobs, and lifecycle callbacks: `references/data-files-events-and-jobs.md`
- Tenant isolation, secrets, URLs, and security review: `references/security-and-tenancy.md`
- Testing, logs, observability, and release checklist: `references/testing-and-observability.md`
- Reusable patterns learned from SotaAgents system apps: `references/system-app-patterns.md`
- Fast diagnosis of common failures: `references/troubleshooting.md`

## Non-negotiable rules

- Do not invent manifest keys. Inspect with `sota manifest schema`, explain with `sota manifest explain <path>`, then validate.
- Never put localhost into the deployable base manifest. Local service and health overrides belong under `environments.local`.
- A native UI imports host APIs from `@sota/platform`; it must not call private Core endpoints directly.
- A backend trusts only a verified Core invocation token. Never trust organization, workspace, installation, actor, scopes, or environment identifiers supplied by the request body or unsigned headers.
- Keep credentials and private keys out of the app bundle, repository, manifest, App Data, logs, and tool output.
- Tool input and output must have explicit JSON Schemas. Tool descriptions must state when to use the tool and what it returns.
- Keep model output compact. Put rich renderer-only payloads behind the supported `_sota` model projection mechanism.
- Actorless events and background work use the environment recorded on their subscription. Never fall through to another environment, and stop work when the relevant installation or environment is no longer valid.
- Use immutable, cacheable asset URLs when possible; do not proxy large files through the app merely to deliver bytes to native UI.

## Definition of done

- The manifest compiles for the intended environment.
- Native UI typechecks against the CLI-pinned App UI contract.
- The app backend verifies Core identity and scopes at the boundary.
- Tool, skill, event, and UI contracts match their routes and schemas.
- The Development path works locally; Staging and Production do not depend on a local tunnel.
- `sota validate` and the app build pass, or remaining failures are reported with exact evidence.
