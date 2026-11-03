# Patterns from SotaAgents system apps

System apps are examples, not the schema authority. Copy the principle, then
validate against the current CLI. Some old app-local docs predate the
Development/Staging/Production lifecycle.

## Knowledge Base: workflow-level tools

Knowledge Base keeps the agent-facing surface small: answer a grounded question,
query documents deterministically, and perform broader analysis. Retrieval,
navigation, reranking, page handling, and evidence assembly remain backend
implementation details.

Use this pattern when a backend can produce more reliable exhaustive/counting or
grounded results than an agent composing many low-level primitives.

Knowledge Base also separates rich renderer material from compact model context
using `_sota` model projections. Apply this to page previews, images, tables, and
large evidence structures.

## Web Search: composable primitives plus method skill

Web Search exposes genuinely reusable operations—search, fetch a page, and image
search—while a content skill teaches the agent how to conduct multi-step
research, budget calls, stop, and cite evidence.

Use this pattern when each operation is independently valuable and the agent's
composition adds real value. Strong tool descriptions explain evidence and next
actions. Schemas use bounds, required fields, enums, and closed objects.

## Office: stable public contracts and lazy UI

Office preserves public contribution/tool names even after product naming
changes. Treat manifest identifiers as APIs once published.

Its skill is a compact dispatcher into focused references. Heavy viewers are
lazy-loaded, host loading states are used, host modules are externalized, and
CSS is scoped under the app root while preserving keyframes.

## Remagine: explicit workflow states

Remagine models the real workflow: create, edit, preview, render, inspect status,
then present. This is clearer and safer than generic storage/navigation tools.

When a domain has durable states, name the transitions and return identifiers
that make progress observable.

## CAD Analyzer: long job protocol

CAD starts expensive work, returns a job identifier, and exposes status. It also
uses content-backed deterministic guidance rather than a needless runtime skill
route.

Use asynchronous job protocols for ingestion, conversion, analysis, or rendering
that exceeds normal tool timeouts.

## Report: centralized tenancy

Report centralizes invocation verification and multi-tenant database filters.
Callers cannot accidentally forget the organization/workspace boundary. Bind
delegated credentials to the same verified context and declared grants.

## Shared frontend lessons

- Export the exact manifest symbol and supported surface mapping.
- Use `useAppFetch` or `platform.fetch` with relative app routes.
- Use browser `fetch` only for intentional presigned/CDN traffic.
- Externalize React and platform modules; use relative build base.
- Scope CSS to `[data-sota-app="<appId>"]`.
- Declare only exact external origins needed for assets, uploads, fonts, media,
  or WASM.
- Let the compiler derive dependencies, integrity, and native graph metadata.

## Shared backend lessons

- Centralize JWT/JWKS verification and error mapping.
- Trust tenant identity only from verified claims.
- Keep heavy workers separate from request serving when necessary.
- Put private durable data in app-owned storage.
- Use App Data only for intentionally shared/platform-visible projections.
- Never treat a hardcoded staging Core origin from an example as Production
  guidance.

## Patterns not to copy

- old frame/iframe UI documentation;
- old Preview/Live command names;
- deploy scripts that bump version before build/validation;
- manually authored compiler fields such as integrity, native `requires`, or
  resolved schema content;
- blanket external-origin permissions;
- tool schemas with unrestricted arbitrary objects;
- hardcoded tenant ids, workspace ids, or staging origins.
