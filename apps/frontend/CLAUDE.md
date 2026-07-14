# Leaf Frontend — Agent Guide

## Stack

- **Framework:** SvelteKit + Svelte 5 (`$state`, `$derived`, `$effect`, `$props`, `$bindable`)
- **Styling:** Tailwind CSS 4 + scoped `<style>` blocks with CSS custom properties
- **Icons:** `lucide-svelte` (static), `@jis3r/icons` (animated, hover-triggered)
- **Animation:** `motion` (motion.dev) — real spring physics via `animate()`
- **Package manager:** pnpm (never bun)
- **Type checking:** don't run `tsc` / `svelte-check` — it's slow and has pre-existing noise

## Design System (hard rules)

Full reference: `apps/frontend/DESIGN.md`. Guardrail: `pnpm check:design` fails any diff
that adds hex colors, legacy tokens, or legacy classes to `.svelte` files.

- Never write a hex color in a `.svelte` file. Use semantic tokens from `src/tokens.css`
  (`--bg-*`, `--text-*`, `--border-*`, `--accent*`, `--status-*`, `--hue-*`) or the
  Tailwind utilities `text-fg/text-muted/text-faint/bg-surface/bg-raised/border-edge`.
- Never use legacy tokens in components (`--center-channel-*`, `--sidebar-*`,
  `--surface-*`, `--control-*`, `--mention-*`, `--online/away/dnd-indicator`,
  `--button-bg/color`, `--error-text-color`, `--link-color`, `--card-bg`). They are the
  private engine layer under `tokens.css`.
- Never use raw `.btn/.card/.badge/.alert/.input/.dropdown/.skeleton` classes in new
  markup. Use `ui/` components (`Button`, `SectionCard`, `Badge`, `Alert`, `Input`,
  `Menu`/`Dropdown`/`PopoverPanel`, `Skeleton`, `EmptyState`, `Modal`).
- All status rendering goes through `ui/status.ts` (`resourceStatus`/`podStatus`/
  `buildStatusMeta`/`runStatus`/`statusMeta`) rendered as `StatusBadge`/`StatusDot`.
  Never hand-roll a status switch; status is never color alone.
- No left-accent borders. Alerts/callouts are tinted bg + subtle full border.
- Labels are a last resort: combine into the value or de-emphasize under it. No
  "Label: value" grids.
- No comments in authored code. No em dashes in UI copy.
- Never redefine motion utilities locally; import from `$lib/utils/motion.svelte`.

## Motion System

All interactive animation uses spring physics from `motion`. CSS `transition` is only for color/opacity on hover states. Any movement, scaling, or layout change must go through a Motion spring.

### Import

```ts
import { springHover, motionStagger, springPop, springCollapse, springRotate, springWidth, motionPopover, motionBackdrop, cardTilt } from '$lib/utils/motion.svelte';
```

### Core utilities (all in `$lib/utils/motion.svelte.ts`)

| Utility | Purpose | Usage |
|---|---|---|
| `springHover(opts?)` | Lift + press/release on hover/click | `{@attach springHover()}` |
| `motionStagger(opts)` | Staggered entrance for lists/grids | `{@attach motionStagger({ index: i })}` |
| `springPop(active)` | One-shot pop when boolean flips to true | `{@attach springPop(() => isActive)}` |
| `springCollapse(collapsed)` | Spring-driven height collapse | `{@attach springCollapse(() => isCollapsed)}` |
| `springRotate(active, opts?)` | Rotate between two angles (chevron toggles) | `{@attach springRotate(() => expanded, { rest: 0, on: 180 })}` |
| `springWidth(active, opts)` | Interpolate width between two values | `{@attach springWidth(() => wide, { rest: 32, on: 200 })}` |
| `motionPopover(opts)` | In/out lifecycle for modals/popovers | `{@attach motionPopover({ closing: () => !open, onClosed })}` |
| `motionBackdrop(closing, onClosed)` | Backdrop fade paired with popover | `{@attach motionBackdrop(() => !open, onClosed)}` |
| `cardTilt(opts?)` | Cursor-tracking 3D tilt | `{@attach cardTilt({ max: 4 })}` |
| `pressSpringDelegate(root, sel)` | Delegated hover/press for many children | Called imperatively in `onMount` |

### Spring tuning reference

| Use case | stiffness | damping | mass | feel |
|---|---|---|---|---|
| Small button hover lift | 380–450 | 22–26 | default | snappy |
| Card hover lift | 340–380 | 22 | default | confident |
| Stagger entrance | 260–280 | 22–24 | 0.85 | smooth cascade |
| Popover open | 520 | 30 | 0.85 | quick, minimal overshoot |
| Popover close | 570 | 36 | 0.85 | tight exit |
| Collapse/expand | 180 | 16–19 | 1.2–1.3 | deliberate |
| Chevron rotation | 380 | 22 | 0.7 | confident |
| Press compress | 520–780 | 26 | default | velocity-modulated |
| Release overshoot | 420 | 14 | 0.7 | lively bounce |

**Rules:**
- Larger objects → higher mass, lower stiffness
- Exit animations → 10–20% stiffer/more damped than entry
- Cursor tracking (realtime) → damping ratio near 1.0
- Never compose two springs writing the same transform axis

### When to use what

- **Interactive element (button, card, link):** `springHover` — gives lift on hover + press/release with velocity-aware compression
- **List of items appearing:** `motionStagger` with `index` — 40–60ms stride per item
- **Section cards on a page:** `motionStagger` with `index` + larger stride (60ms) for a cascade effect
- **Expand/collapse content:** `springCollapse`
- **Toggle indicator (chevron, arrow):** `springRotate`
- **Modal/popover lifecycle:** `motionPopover` + `motionBackdrop` with render-flag pattern
- **Numeric value change:** Use `animate(0, target, { onUpdate })` directly
- **Ambient loops (pulse, breathing):** CSS `@keyframes` only — Motion is for state transitions

### Animated icons (`@jis3r/icons`)

These icons have built-in hover animations. To trigger animation from a parent element instead of the icon itself:

1. Track hover state on the parent: `onmouseenter={() => (hovered = true)}`
2. Pass to icon: `<Unplug size={14} animate={hovered} />`
3. Wrap icon in `pointer-events: none` span to prevent its internal handlers from fighting

For snippet-based components, pass hover as a snippet parameter:
```svelte
<!-- Component declares: icon?: Snippet<[boolean]> -->
{#snippet icon(hovered)}<KeyRound size={18} animate={hovered} />{/snippet}
```

### Component patterns

**Reusable settings primitives** (in `$lib/components/user-settings/`):
- `SettingsSection` — card wrapper with animated icon header, stagger entrance
- `SettingsField` — inline-editable field with pencil animation on cell hover
- `IntegrationCard` — connected service with unplug animation on disconnect hover
- `ConnectPrompt` — dashed CTA with springHover lift + chevron animation
- `StatusPill` — connected/not connected indicator
- `IconButton` — small action button with springHover + icon animation via snippet param

## Svelte 5 patterns

- Use `$state` for component-local reactive state
- Use `$derived` for computed values
- Use `$effect` for side effects (but never read+write the same `$state` in one effect — use a plain `let` sentinel)
- Use `$props()` for component inputs, `$bindable()` for two-way bindings
- Use `{@attach fn()}` to attach Motion utilities to elements
- Use `{#snippet name(params)}...{/snippet}` for typed render slots

## Resource Quota System

Three-level hierarchy: **Org cap** → **Member allowance** → **Deployment request**.

**Backend** (`server/src/quotas/`):
- `GET /organizations/:orgId/quota` — org usage vs caps (admin only)
- `GET /organizations/:orgId/quota/me` — current user's allowance, usage breakdown, org cap, and `effectiveLimit`
- `effectiveLimit` = `min(userAllowanceRemaining, orgCapRemaining)` — the max the user can assign to a single new deployment right now
- Member allowance cascade: explicit → org default → unlimited
- Enforcement at deploy create, scale, and resource update

**Frontend**:
- `ResourcePicker` shows a "budget" bar: current request vs `effectiveLimit`
- If unlimited and org has cap: budget shows org remaining
- If no caps at all: shows "Unlimited" badge
- Over-limit input shows red warning
- Usage page (`/[orgSlug]/usage?tab=me`) shows speedometers with same logic

**UX rule**: never show redundant description text. Section titles should be self-explanatory ("CPU & Memory", "Container Image", "Your resource budget").

## Deployment Page Architecture

- Tabs: Overview, Environment, Resources, Storage, Network, Metrics, Deploys, Advanced
- `DeploymentAlerts` — unified alert banner above tabs for build failures, pod crashes, resource pressure, SSE disconnect
- SSE drives real-time updates; TanStack Query with adaptive polling as fallback
- `humanizeWarning()` in `$lib/utils/format.ts` translates k8s events to plain English with severity levels
- Header collapse uses spring physics (height eased, card scaleY bounce on collapse)

## File organization

- Routes: `src/routes/`
- Shared components: `src/lib/components/`
- Feature components: `src/lib/components/<feature>/` with `index.ts` barrel export
- Utilities: `src/lib/utils/`
- Stores: `src/lib/stores/`
