# Tool input streaming surfaces

## What this capability streams

This capability renders the native tool-result component while the model is
still generating the tool call arguments. It does not stream backend execution
progress and does not change the tool HTTP response protocol.

Core already owns the ordered lifecycle:

```text
input-streaming -> input-available -> output-available | output-error | output-denied
```

- `input-streaming`: the model is producing JSON arguments; `input` is partial
  and must be treated as `unknown`;
- `input-available`: arguments are complete and schema-valid; the tool may now
  be awaiting approval or executing;
- terminal output states: the same mounted component receives the final result
  or error.

Progress for a minutes-long app job is a separate app-owned job/status design.
Do not hold a tool request open or invent a streaming backend protocol for this
UI capability.

## Manifest opt-in

Legacy tool renderers mount only after output. Opt in per native renderer:

```yaml
platform: ^1.2.0
contributes:
  tools:
    - name: draft_report
      description: Generate a report from a detailed brief.
      route: POST /tools/draft-report
      inputSchema: src/schemas/draft-report-input.schema.json
      outputSchema: src/schemas/draft-report-output.schema.json

  ui:
    - id: draft-report-result
      kind: nativeModule
      surface: tool-view
      slot: chat.message.inline.below
      toolNames: [draft_report]
      renderBeforeOutput: true
      module:
        entry: dist/ui/app.js
        export: DraftReportResult
        styles: dist/ui/app.css
```

`renderBeforeOutput` is valid only on native `tool-view` and `message-part`
surfaces. Apps that do not opt in keep final-only behavior.

## Component contract

Use the public discriminated type instead of declaring a loose local object:

```tsx
import type { ToolResultSurfaceProps } from '@sota/platform';

type DraftReportInput = {
  title: string;
  brief: string;
  sections: string[];
};

type DraftReportOutput = {
  reportId: string;
  summary: string;
};

export function DraftReportResult({
  toolResult,
}: ToolResultSurfaceProps<DraftReportInput, DraftReportOutput>) {
  if (toolResult.state === 'input-streaming') {
    return <InputPreview partial={toolResult.input} />;
  }

  if (toolResult.state === 'input-available') {
    return <RunningReport input={toolResult.input} />;
  }

  if (toolResult.state === 'output-error') {
    return <ErrorNotice message={toolResult.errorText ?? 'Tool failed'} />;
  }

  if (toolResult.state === 'output-denied') {
    return <p>Tool approval was denied.</p>;
  }

  if (toolResult.state !== 'output-available') return null;
  return <ReportSummary result={toolResult.result} />;
}

export const surfaces = { DraftReportResult };
```

During `input-streaming`, do not cast partial input to the full input schema.
JSON strings may still be truncated, required fields may be absent, arrays may
grow, and nested objects may be incomplete. Use defensive inspection or a
generic JSON preview. From `input-available` onward, `input` has the declared
generic input type.

`result` is the app payload unwrapped from Core transport metadata. `output` is
the raw tool output for compatibility and diagnostics. Prefer `result` for app
UI. The exact app/environment execution provenance and canonical app tool name
are Core-stamped.

## Mount and replay behavior

Core mounts one surface per tool call and updates its props in place. Local React
state survives input deltas and the transition to the final result. If the
module loads late, it receives the latest materialized tool part rather than a
replay of every prior delta.

Returning `null` hides UI but does not cancel the tool. A render exception is
contained by the native surface boundary; the generic Core tool activity remains
the fallback. Historical completed messages continue to render from their
stored terminal output—partial model input is transient and is not a second
durable result stream.

## Safety and performance

- Never execute side effects from partial input; the model can revise it.
- Do not call the app backend once per input delta.
- Keep streaming rendering cheap and resilient to `undefined` input.
- Do not expose secrets merely because arguments become visible earlier.
- Use `aria-busy` or a concise status label; do not announce every token/delta.
- Test an empty start, malformed partial JSON, long strings, cancellation,
  approval, terminal error, late module load, and conversation history reload.
