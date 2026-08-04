# Orchard Design System

The mini design system for `apps/frontend`. Tokens → primitives → patterns. Every screen
is built from these; nothing is a one-off. The guardrail (`pnpm check:design`) ratchets
debt down: it fails any change that adds hex colors, legacy tokens, or raw legacy classes
to `.svelte` files.

## Principles (Refactoring UI, house rules)

- Data drives design: decide what the data means before deciding how it looks.
- Hierarchy via weight, contrast, and spacing, not size. Small muted section titles;
  the content is the focus, never the label.
- Labels are a last resort. Combine label into value ("3 replicas", "deployed 2m ago"),
  or de-emphasize the label under a value-first display. Never "Name: foo" grids.
- Progressive disclosure: frequent actions visible, rare actions behind menus,
  accordions, or tabs.
- Emphasize by de-emphasizing: mute the neighbors instead of shouting.
- Fewer borders: prefer spacing and background shifts over boxes in boxes.
- Status is never color alone: always a dot, icon, or label alongside the color.
- Alerts and callouts: tinted same-hue background plus a subtle full border.
  Never left-accent borders.
- Empty states are deliberate: an invitation to act, not a shrug.
- UI copy: sentence case, active voice, plain verbs, no filler, no em dashes.
  Buttons say exactly what they do.
- Authored code is comment-free.

## Tokens (`src/tokens.css`)

Semantic layer aliased over the legacy theme vocabulary. Components use ONLY these
(plus `--color-primary-*` and fonts from `@theme`). The legacy names
(`--center-channel-*`, `--sidebar-*`, `--surface-*`, `--control-*`, ...) are the private
engine layer for `app.css`/`theme.ts` and must not appear in components.

| Token                                                               | Meaning                                                                  |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `--bg-app`                                                          | page background                                                          |
| `--bg-surface`                                                      | default component surface                                                |
| `--bg-raised`                                                       | card surface                                                             |
| `--bg-sunken`                                                       | inputs, wells                                                            |
| `--bg-hover`                                                        | hover fill                                                               |
| `--bg-overlay`                                                      | dropdowns, popovers                                                      |
| `--text-default` / `--text-muted` / `--text-faint`                  | text hierarchy                                                           |
| `--text-link` / `--text-on-accent`                                  | link text, text on accent fills                                          |
| `--border-default` / `--border-strong`                              | borders                                                                  |
| `--accent` / `--accent-subtle` / `--focus-ring`                     | brand crimson interactions                                               |
| `--status-success/-warning/-error/-info/-neutral/-progress`         | status colors (each also has `-bg` and `-border` recipes)                |
| `--hue-gray/-slate/-blue/-green/-emerald/-violet/-pink/-red/-amber` | decorative categorical palette (nav badges, env colors, brand-ish icons) |

Tailwind utilities from the same layer: `text-fg`, `text-muted`, `text-faint`,
`bg-surface`, `bg-raised`, `bg-sunken`, `border-edge`, `text-accent`. Prefer these over
`style="color: var(...)"`.

Global status color classes: `.status--{success|warning|error|info|neutral|progress}`
set `color:`; pair with `currentColor` backgrounds for tinted chips and dots.

## Status (`src/lib/components/ui/status.ts`)

The ONLY source of status → kind/label/icon mapping. Never hand-roll a status switch.

- `resourceStatus(status?, buildStatus?)`: deployments, databases, stacks, template
  instances. Build in flight dominates.
- `podStatus(phase?)`: pod phases.
- `buildStatusMeta(buildStatus?)`: build rows.
- `runStatus(status)`: job runs.
- `statusMeta(kind, label, pulse?)`: custom cases (connected/not connected, etc).

Render with `<StatusBadge meta={...} />` (tinted pill, dot + label) or
`<StatusDot meta={...} size={n} />` (dot only, pulses when meta.pulse).

## Component decision trees

- Status indicator → `StatusBadge` / `StatusDot`. Taxonomy label (env name, plan,
  build type) → `Badge` or a `--hue-*` tinted chip. Never `Badge` for status.
- Action list on a trigger → `Menu` + `MenuItem`. Value picker → `Dropdown` / `Select`.
  Free-form floating panel → `PopoverPanel`.
- Dialog → `ui/Modal` (or `ConfirmModal` for confirmations). Never a bespoke overlay.
- Section container → `SectionCard`. Loading → `ui/Skeleton`. Nothing → `ui/EmptyState`.
- Buttons/inputs → `ui/Button`, `ui/Input`, `ui/Field`, `ui/Select`. The global
  `.btn/.card/.badge/.input/.alert` classes are legacy: never in new markup.

## Motion

See CLAUDE.md Motion System. One canonical implementation per utility in
`$lib/utils/motion.svelte.ts`; never redefine locally.

Timing is never written at a call site. Pick one of four named springs
(`smooth`, `snappy`, `bouncy`, `interactive`) and let `transition()` resolve it
against the user animation level (Settings → Accessibility). No `stiffness`,
`damping`, or `mass` in components.

Every animation must respect the animation level: the motion utilities gate
themselves; svelte transitions come from `$lib/utils/transitions` (never
`svelte/transition` directly); one-off `animate()` calls take `transition(name)`
as their options, or go through `motion()` to also drop transforms at `reduced`.
CSS keyframes are killed below `full` by default, so a progress indicator that
must keep spinning needs `data-motion="progress"`.

## Guardrail

`pnpm check:design` (also runs in root `pnpm lint`). Counts hex colors, legacy token
usage, and legacy classes in `.svelte` files against `design-baseline.json`; fails only
on increases. After paying down debt, tighten with `pnpm check:design --update`.
