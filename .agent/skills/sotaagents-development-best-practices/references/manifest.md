# Manifest v3

## Authority and inspection

The manifest is a compiled contract, not a free-form configuration file.
Unknown fields are rejected. When uncertain:

```bash
sota manifest schema
sota manifest explain contributes.tools
sota validate
```

The current schema and compiler diagnostics take precedence over examples.

## Required root fields

A minimal current app has:

```yaml
manifestSchemaVersion: { { CURRENT_MANIFEST_MAJOR } }
appId: my-app
version: 1.0.0
publisher:
  id: my-team
  displayName: My Team
  contact: dev@example.com
contributes:
  skills: []
```

`manifestSchemaVersion` chooses the parser. `version` identifies an immutable app
artifact. `platform` expresses compatible host versions and is normally needed
for native UI. Do not use one version field as a substitute for another.
The local registry marks majors 2, 3 as accepting the
canonical contribution shape used by `sota add`.

## Environment overlays

The base manifest describes the deployable app. Localhost belongs only in the
local overlay:

```yaml
service:
  baseUrl: https://my-app.example.com
health:
  url: https://my-app.example.com/health
  intervalSeconds: 60
environments:
  local:
    service:
      baseUrl: http://localhost:8787
    health:
      url: http://localhost:8787/health
```

Development resolves `environments.local` and the active tunnel. Staging and
Production use their deployed backend configuration. Do not add custom flags to
choose an environment in application code.

## Compile-time behavior

The compiler:

- applies the selected environment overlay;
- validates every field and cross-reference;
- resolves and inlines JSON Schemas and locale files;
- traces native module entry/style assets;
- verifies paths remain inside the app;
- computes integrity and bundle metadata;
- rejects incompatible, ambiguous, or missing contributions.

Therefore a referenced file must exist before build/deploy even if its route is
not exercised during a local smoke test.

## Service and health

Declare `service` when any contribution needs dynamic backend invocation:

- route-backed tools or skills;
- backend routes used by native UI;
- events, lifecycle callbacks, or jobs;
- a health endpoint.

The local and deployable health URLs should target the same app service. Keep the
health response cheap, unauthenticated where platform health checks require it,
and free of secrets.

## Tools

```yaml
contributes:
  tools:
    - name: search_records
      description: Search records by explicit filters and return matching summaries.
      route: POST /tools/search-records
      inputSchema: src/schemas/search-input.schema.json
      outputSchema: src/schemas/search-output.schema.json
      timeoutMs: 15000
      failure_mode: abort
      searchHint: records lookup filtering
```

Names are stable API identifiers. Use specific descriptions, explicit input and
output schemas, realistic timeouts, and the failure mode appropriate to whether
the agent may continue safely.

## Skills

Use exactly one content source:

```yaml
contributes:
  skills:
    - name: policy-guide
      description: Company policy interpretation guidance.
      appendsTo: system
      content: src/skills/policy-guide
      timeoutMs: 3000
      failure_mode: skip
```

Choose `route` instead of `content` for dynamic, tenant-aware material. Do not
declare both for the same skill.

## Native UI

```yaml
platform: ^1.1.0
locales:
  default: en
  files:
    en: src/locales/en.json
contributes:
  ui:
    - id: admin-screen
      kind: nativeModule
      surface: page
      slot: admin.workspace.tab
      sectionId: my-app
      label: Admin screen
      route: /my-app/*
      module:
        entry: dist/ui/app.js
        export: AdminScreen
        styles: dist/ui/app.css

    - id: user-settings
      kind: nativeModule
      surface: page
      slot: user.settings.tab
      label: My app settings
      route: /my-app/user-settings
      module:
        entry: dist/ui/app.js
        export: UserSettings
        styles: dist/ui/app.css

    - id: prompt-templates-panel
      kind: nativeModule
      surface: composer-panel
      slot: chat.composer.panel
      label: Prompt templates
      module:
        entry: dist/ui/composer-panel.js
        export: ComposerPanel
        styles: dist/ui/composer-panel.css

  slashCommands:
    - verb: templates
      scope: workspace
      description: Choose a reusable prompt template.
      mode: insert-only
```

The module points to built artifacts, not source. `id`, export name, surface,
slot, route, and optional tool bindings must agree with the actual code.

`user.settings.tab` mounts inside the Account Settings dialog for an explicit
active workspace. It is not a browser route. Keep its semantic route
app-namespaced and make the UI responsive to the bounded, scrollable panel.

A composer panel and an `insert-only` slash command are independent. Do not add
a slash `target` merely to connect them. The panel can observe the composer with
`useComposer`, decide when to return UI or `null`, and edit the draft locally.
Read `composer-panels-and-input.md` for the runtime and input-editing contract.

A native `tool-view` or `message-part` renderer is final-only by default. To
mount the same component while the model is still generating the tool input,
declare `renderBeforeOutput: true` on that UI contribution and require platform
`^1.2.0` or newer. This streams model-authored input into the renderer; it does
not stream backend tool execution. Read `tool-input-streaming-surfaces.md` for
the typed lifecycle and partial-input rules.

## External origins

Allow only exact HTTPS origins when a contribution needs browser access to an
external service. Do not enter path prefixes, wildcards, localhost, credentials,
or internal network addresses. Prefer app-backend access for secret-bearing APIs.

## Common failures

- Unknown property: remove it; do not assume future schema fields.
- Missing referenced file: correct the path or generate the artifact.
- Localhost outside `environments.local`: move the override.
- Service required: declare a deployable service and local override.
- Duplicate contribution name or id: keep identifiers unique.
- UI export mismatch: align manifest export with the named module export.
- Composer panel mismatch: use `surface: composer-panel` with exactly
  `slot: chat.composer.panel`.
- Early tool renderer on another surface: `renderBeforeOutput` is valid only on
  native `tool-view` and `message-part` contributions.
- Local slash command dispatches a turn: use `mode: insert-only` without a
  `target` or `handler`.
- Invalid route: use the method/path format accepted by the schema.
- Schema path escape: keep all contribution files inside the app root.
- Deployment URL still ends in `.invalid`: configure the real hosted backend.
