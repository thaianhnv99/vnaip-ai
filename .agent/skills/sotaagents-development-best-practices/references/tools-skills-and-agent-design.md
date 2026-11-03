# Tools, skills, and agent design

## Start from the user workflow

Expose the smallest set of tools that lets the agent reliably complete meaningful
work. Do not map every internal repository or navigation primitive directly to a
tool.

Choose workflow-level tools when the backend can search, plan, count, verify, or
aggregate more reliably than the model. Keep internal primitives private. Use
composable public primitives only when independent composition is genuinely part
of the product.

Examples of sound shapes:

- knowledge work: `answer`, `documents.query`, `analyze`;
- web research: search, fetch page, and image search plus a skill that teaches
  the multi-step research workflow;
- media workflow: create, edit, preview, render, status, present;
- long ingestion: start upload, return job id, poll status.

## Tool descriptions

A useful description answers:

- When should the agent call this?
- What work does the backend perform?
- What evidence or data comes back?
- What important limit or precondition applies?
- What should the agent do next with the result?

Do not merely repeat the tool name. Keep stable public names after release because
prompts, integrations, renderers, and stored conversations may refer to them.

## Schemas

Every tool needs input and output JSON Schemas, even when input is empty.

Prefer:

- explicit `required`;
- `additionalProperties: false` when the object is closed;
- bounded strings and arrays;
- enums for known modes;
- meaningful property descriptions;
- stable result discriminators;
- typed error or partial-result states when they are part of normal behavior.

Avoid a universal `object` schema or unbounded arbitrary JSON unless openness is
the actual contract. Validate again at the backend boundary.

## Output planes

The model and renderer often need different payloads:

- model: compact conclusions, ids, citations, counts, and next actions;
- renderer: richer cards, images, tables, source details, or downloadable assets.

Use the supported `_sota.modelOutput` field when the model needs a completely
different result. Use `_sota.modelProjection.omitKeys` to remove renderer-only
keys from model context. Keep renderer data bounded and avoid placing secrets,
huge documents, or raw binaries in either plane.

Renderers should consume structured output and degrade to a readable plain tool
result if the UI module is unavailable.

## Counting and exhaustive analysis

Semantic retrieval answers “what is relevant,” not necessarily “how many exist.”
For exhaustive count/list/group/filter tasks, provide a workflow-level query or
analysis tool that can enumerate the authoritative indexed/document set, apply
filters deterministically, and report coverage.

Return:

- the exact operation and filters;
- matched and inspected counts;
- pagination/completeness state;
- aggregates and representative evidence;
- warnings when the result is sampled or truncated.

Do not claim an exact count from top-k retrieval results.

## Long-running tools

Do not hold an HTTP request for a long ingest/render operation. Start work,
return a stable job id and accepted state, then expose a status/read-result tool.
Make repeated status calls cheap and make start calls idempotent where possible.

## Skills

Use content-backed skills for deterministic, package-owned guidance:

```yaml
content: src/skills/my-skill
```

Use a route-backed skill only when instructions depend on verified tenant or
runtime state. Removing a needless network/auth hop improves reliability.

For a large skill:

- keep `SKILL.md` a concise dispatcher;
- put detailed aspects in focused files under one `references/` level;
- define tool budgets, stop conditions, failure behavior, and evidence rules;
- explain which reference to read for each task;
- avoid copying the entire platform reference into every prompt.

Agents author `content`; compiler-generated `staticContent` is not source.

## Failure modes

Choose `abort` when continuing could produce an unsafe or falsely successful
answer. Choose `skip` only when the contribution is optional and the agent can
still act honestly without it. Do not hide a failed write or authoritative query
behind a graceful-looking response.

## Citations and artifacts

Use stable declared message-renderer tokens for citations/artifacts rather than
requiring Core to understand app-specific data. Keep identifiers stable,
authorize dereference at view time, and provide plain-text fallback context.
