# Composer panels and input

## Two independent capabilities

A slash command and a composer panel are independent manifest contributions:

- `slashCommands[].mode: insert-only` registers a local composer command and
  inserts its slash reference when selected;
- a native `composer-panel` contributes custom UI above or below the active
  composer and may render or return `null` from any app-owned condition.

Do not link the slash command to the panel with `target`. Targets are for
executable tool, skill, or page commands. One panel may observe several slash
commands, several panels may observe the same command, and either contribution
may exist without the other.

```yaml
platform: ^1.1.0
contributes:
  slashCommands:
    - verb: templates
      scope: workspace
      description: Choose a reusable prompt template.
      mode: insert-only
  ui:
    - id: prompt-templates-panel
      kind: nativeModule
      surface: composer-panel
      slot: chat.composer.panel
      label: Prompt templates
      module:
        entry: dist/ui/app.js
        export: ComposerPanel
        styles: dist/ui/app.css
```

The panel module uses the same `surfaces` export shape as other native UI:

```ts
export const surfaces = { ComposerPanel };
```

## Reading the active composer

`useComposer` is available only while rendering a `composer-panel` surface.
Import it from the public Core hook contract and use a selector so the component
subscribes only to the state it needs:

```tsx
import { useComposer } from '@sota/core/hooks';

export function ComposerPanel() {
  const value = useComposer((composer) => composer.value);
  const applyEdit = useComposer((composer) => composer.applyEdit);

  if (!/(^|\s)\/templates\b/i.test(value)) return null;

  return (
    <button
      type="button"
      onClick={() =>
        applyEdit({
          mode: 'replace',
          content: [{ kind: 'text', text: 'Review this sales pipeline: ' }],
        })
      }
    >
      Sales pipeline
    </button>
  );
}
```

The public state contains:

- `value`: plain-text projection of the current draft;
- `content`: structured text and app-reference nodes;
- `references`: slash, conversation, and app references already in the draft;
- `applyEdit(edit)`: one atomic editor transaction;
- `focus()`: return focus to the composer.

The hook is bound to the exact composer hosting that panel. It throws a clear
capability-unavailable error outside a composer-panel surface; do not try to
import the host editor or access its Zustand store directly.

## Editing without losing input

Choose the edit mode deliberately:

- `replace` replaces the whole draft;
- `insert-at-cursor` inserts at the current selection;
- `append` adds content to the end.

If a previous draft disappeared after a template click, the app chose `replace`.
Core did not discard it independently. Use `append`, `insert-at-cursor`, or
compose a replacement from the current structured content:

```tsx
const content = useComposer((composer) => composer.content);
const applyEdit = useComposer((composer) => composer.applyEdit);

applyEdit({
  mode: 'replace',
  content: [...content, { kind: 'text', text: ' New section' }],
});
```

Do not concatenate only `value` when the draft may contain structured
references; doing so flattens them into text. `applyEdit` preserves editor undo,
selection, focus, and serialization as one transaction.

## App references and model fallback

Use an `app-reference` when a selected UI object should remain structured in the
composer and conversation history:

```ts
applyEdit({
  mode: 'replace',
  content: [
    { kind: 'text', text: 'Use the ' },
    {
      kind: 'app-reference',
      referenceType: 'prompt-template',
      referenceId: 'sales-pipeline',
      label: 'Sales Pipeline',
      fallbackText: 'Analyze pipeline health, risks, and next actions.',
    },
  ],
});
```

Core attaches the trusted app and execution provenance. The model receives the
bounded `fallbackText`; app-specific semantic resolution remains app-owned.
Never put secrets or unbounded document bodies in a reference.

## Headless presentation and overlay arbitration

Core supplies placement, switching, keyboard ownership, and accessibility
arbitration, but no border, background, padding, or panel chrome. The app owns
all visible UI. Returning `null`, using `display: none`, or producing zero-size
normal-flow content makes the panel absent.

When several slash, mention, or native panels are present, Core shows one active
overlay and switching controls. Hidden panels stay mounted so app state is
preserved, but do not receive pointer, keyboard, or accessibility focus. A
registered panel that returns `null` is not counted, so one visible panel never
gets unnecessary arrows.

Avoid fixed/absolute positioning against the page. Render normal-flow content
inside the host-provided panel mount and let the composer deck choose top or
bottom placement for Home, Chat, and Project.

## Submission behavior

An `insert-only` slash command never dispatches an executable agent invocation.
If the app leaves `/templates` in the draft, it may remain as fallback text, but
Core omits structured slash invocation metadata for the model turn. Usually the
panel should transform or remove the token as part of the selected edit.
