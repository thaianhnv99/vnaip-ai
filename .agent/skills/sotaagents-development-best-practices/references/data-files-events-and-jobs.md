# App Data, files, events, and jobs

## Where durable data belongs

App-private domain data belongs in the app's own database or object store.
Container-local disk is temporary and appropriate only for local development,
cache, or bounded scratch work.

Use App Data when the app deliberately publishes a platform-visible or
cross-capability projection—not as the default database for all app internals.
Define scope, ownership, schema version, indexes, retention, and migration before
writing records.

## Environment isolation

Treat Development, Staging, and Production as separate environment instances.
Do not let a Development call read or mutate Production data merely because the
same app id is used. Every store key and query must include the verified
environment/installation/tenant dimensions required by the contract.

Development data should follow the Development session where the platform
defines session-aware storage. Staging remains disposable. Production is durable.

## Single writer and shared projections

For shared App Data:

- declare one authoritative writer;
- publish a stable versioned shape;
- let consumers handle compatible evolution;
- migrate explicitly rather than changing key meaning in place;
- create indexes with stable names and compatible definitions;
- never rely on callers remembering tenant filters.

Centralize query construction so organization/workspace/installation filters
cannot be omitted.

## Files and assets

Store large files in object storage. Prefer direct upload/download using
authorized, short-lived URLs and immutable public/CDN URLs for safe public
assets. Keep metadata and authorization checks separate from the byte path.

Do not:

- write durable uploads to container-local disk;
- send storage credentials to native UI;
- stream every asset through the app/Core when a safe direct URL exists;
- place large base64 payloads in tool results or App Data;
- assume a presigned URL remains valid indefinitely.

## Events

Declare only event routes actually implemented. Verify invocation identity and
scope before accepting an event. Event handlers should be:

- idempotent;
- safe to retry;
- bounded in request time;
- observable by event id and outcome;
- explicit about partial failure.

Actorless delivery uses the environment recorded on its subscription. Do not
fall through to Production, route it to an arbitrary developer session, or
invent an actor.

## Background jobs

Heavy ingestion, indexing, conversion, and rendering belong in workers separate
from latency-sensitive request serving when scale warrants it. The request route
should enqueue work and return a job id; a status route/tool exposes progress.

Bind every job to verified app environment, installation, organization, and
workspace. Use a short-lived callback/job token if Core requires callbacks.
Stop or reject work when the environment/installation that authorized it has
been removed or is no longer active.

`sota dev` tunnels the HTTP service; it does not supervise detached workers.
Start local workers explicitly in the app's own development command.

## Lifecycle callbacks

Lifecycle callbacks are opt-in contracts, not boilerplate. Declare only callbacks
the backend implements and needs. Make install/upgrade/uninstall handling
idempotent, because delivery can retry.

Uninstall should stop new work and revoke app access immediately. Retention or
deletion of app-owned data must follow the product's explicit policy rather than
an implicit guess.

## Migrations

- Version durable schemas.
- Make forward migrations observable and resumable.
- Test unique-index changes against actual stored data.
- Avoid deployment sequences where old code cannot read already-migrated data.
- Coordinate code, worker, and data rollout when multiple processes share the
  store.
