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
- Svelte transitions come from `$lib/utils/transitions`, never `svelte/transition`.
  Raw `animate()` calls take `transition(name)` as their options; css keyframes are
  killed below `full` by default, so a spinner opts back in with `data-motion="progress"`.
- Never write `stiffness`, `damping`, or `mass` in a component. Name a spring.

## Motion System

All interactive animation uses spring physics from `motion`, modelled on Apple's motion design. CSS `transition` is only for color/opacity on hover states. Any movement, scaling, or layout change must go through a Motion spring.

### Named springs

Springs are described the way SwiftUI describes them, by perceptual duration and bounce, not by stiffness and damping. **Never write `stiffness`, `damping`, or `mass` in a component.** Pick a name:

| Name | visualDuration | bounce | Use for |
|---|---|---|---|
| `smooth` | 0.26 | 0.2 | entrances, collapse, height and layout change |
| `snappy` | 0.19 | 0.25 | the default. popovers, toggles, hover, chevrons, panel chrome |
| `bouncy` | 0.28 | 0.45 | one-shot celebratory pops, sparingly |
| `interactive` | 0.1 | 0.2 | press feedback and anything tracking the pointer |
| `cinematic` | 0.6 | 0.14 | full-viewport choreography seen once, like the setup overture. Never chrome |

Keep bounce high and duration low. The bounce is what reads as alive; the duration is what reads as slow. The folder demo's 0.37s is sized for a full-screen gesture — application chrome opening a panel wants a fraction of that.

Tuned against motion.dev's iOS app folder example, whose signature spring is `stiffness: 200, damping: 22` — 0.37s at 0.22 bounce. `smooth` is that spring.

`visualDuration` is the time to first reach the target, so a spring reads as fast as its number says regardless of settle time. **Bounce is what makes motion feel fast.** A zero-bounce spring asymptotes into place and reads as sluggish however short you make it; a bouncy spring arrives early and overshoots, which reads as quick and physical. Never set bounce to 0 to "calm something down" — shorten it instead.

Exits leave quicker and looser than entrances, as the demo's do: pass `{ exit: true }` to shorten by 20% and add 0.15 bounce.

```ts
motion(el, { opacity: 0, scale: 0.94 }, 'snappy', { exit: true });
```

### Coming from somewhere

Things that appear should come from where they were, not fade in from nowhere. `originBurst` measures a real page-space point (the control you clicked) and launches each item out of it at 0.2 scale along its own vector, reversing on close. Three details make it read as mass rather than decoration:

- the origin is **measured**, not a generic `y: 8` offset, so every item has a different trajectory
- opacity **lags the movement by 50ms** on exit, so an item is still visible while it travels home. In lockstep it vanishes before it arrives and reads as a fade
- the exit stagger is **reversed**, so the furthest item leaves first

### State that arrives on its own

Most of what Orchard shows is not typed in by the user. Build steps advance, pods crash, replicas come up — it arrives over SSE and the pod informer, and it describes something that **already happened on the cluster**. `DeploymentAlerts` even keeps grace windows because that state genuinely flaps.

So the normal rule inverts. Animating *into* a reality-driven state adds latency to information: a pod that died 200ms ago should not spend another 350ms springing a red dot into view. The state lands instantly, and only its **trail** is animated — which is also the thing that tells you what changed while you were on another tab.

`stateEcho(key)` does exactly that: when `key()` changes it drives `--echo` from 1 to 0 over 0.8s. Add `.motion-echo` plus an `echo--<kind>` class (or set `--echo-color`) and it paints a decaying ring in the status colour.

The ring is a `<span class="motion-echo-ring">` the attachment creates and removes itself, **not** a `::before`/`::after`. Components here already use both pseudo-elements for shadow and border layers, and at equal specificity source order wins silently — a pseudo-element version of this compiled fine, animated its variable correctly, and painted absolutely nothing.

```svelte
<a class="dash-card motion-echo echo--{m.kind}" {@attach stateEcho(() => m.kind)}>
```

Wired to `DeploymentCard`, `DatabaseCard`, and build step rows. It never fires on mount, since a freshly rendered list has not just changed. It survives `reduced` as a plain fade, because it carries information and moves nothing.

**Use a named spring when the user caused the change. Use `stateEcho` when the cluster did.**

### Overlays

Every transient surface — `Menu`, `PopoverPanel`, and anything built on them — goes through `overlayMotion`. It replaced a 130ms CSS keyframe that had **no exit at all**, because the same rule that hid the panel used `display: none`, so panels vanished rather than dismissed.

Two constraints come from these being native popovers:

- the element is not in the top layer until the library calls `showPopover()`, which happens *after* the Svelte effect. Animating immediately runs against a non-rendered element and completes instantly, so the entrance is deferred one frame.
- the library rewrites the element's `style` attribute while positioning it, so an inline "start hidden" seed is gone by the next frame. The closed state is seeded with the `.motion-entering` class instead, dropped once the animation owns the property.

**Interruptibility** (WWDC18 *Designing Fluid Interfaces*): a fresh open passes explicit `[from, to]` keyframes, but an interrupted one passes **targets only**, so the spring continues from the live on-screen values instead of snapping back to the start. Reversing a half-open menu picks up where it actually is.

### Performance

Only `height`/`width` force layout; `transform` and `opacity` are compositor-only. The app animates opacity (15), y (12), scale (12) and height (5) — so layout work is confined to the handful of collapses.

Measured on the widest case (11-tile card): forced layout **0.1ms median, 2.7ms worst** against a 16.7ms frame budget, and **zero long tasks**. If you add a height animation over a large subtree, re-check that number rather than assuming.

### Accessibility tiers

Every animation resolves through `transition(name)`, which rewrites itself per the user's animation level (Settings → Accessibility):

| Level | Behaviour |
|---|---|
| `full` | the named spring, transforms allowed |
| `reduced` | a **260ms** cross-fade, transforms stripped and stagger set to zero. Deliberately *not* faster than `full` |
| `off` | nothing animates. `MotionGlobalConfig.skipAnimations` stops Motion itself, CSS transitions are clamped, and the mesh gradient stops drifting |

**`reduced` is a cross-fade, not a fast-forward.** Compressing the same choreography into a fraction of the time makes things worse for the people who asked for less motion — a 500px panel closing in 120ms is a snap, exactly the abrupt change Reduce Motion exists to avoid. The tier keeps an unhurried duration and removes the *motion* instead: `adapt` strips transforms, the stagger goes to zero (a wave travelling across a group is choreography even when nothing translates), and opacity carries the change.

`system` follows `prefers-reduced-motion`. CSS `@keyframes` are killed below `full` by default; a progress indicator that must keep spinning opts back in with `data-motion="progress"`.

### Import

```ts
import { springHover, motionStagger, springPop, springCollapse, springRotate, springWidth, motionPopover, motionBackdrop, magneticHighlight, transition, motion } from '$lib/utils/motion.svelte';
```

### Core utilities (all in `$lib/utils/motion.svelte.ts`)

| Utility | Purpose | Usage |
|---|---|---|
| `transition(name, opts?)` | Resolve a named spring for the current tier | `animate(el, kf, transition('smooth'))` |
| `motion(el, kf, name?, opts?)` | Tier-aware `animate` that also drops transforms at `reduced` | `motion(el, { opacity: 0, y: 8 }, 'smooth')` |
| `springHover(opts?)` | Lift + press/release on hover/click | `{@attach springHover()}` |
| `motionStagger(opts)` | Staggered entrance for lists/grids | `{@attach motionStagger({ index: i })}` |
| `springPop(active)` | One-shot pop when boolean flips to true | `{@attach springPop(() => isActive)}` |
| `springCollapse(collapsed)` | Spring-driven height collapse | `{@attach springCollapse(() => isCollapsed)}` |
| `springRotate(active, opts?)` | Rotate between two angles (chevron toggles) | `{@attach springRotate(() => expanded, { rest: 0, on: 180 })}` |
| `springWidth(active, opts)` | Interpolate width between two values | `{@attach springWidth(() => wide, { rest: 32, on: 200 })}` |
| `motionPopover(opts)` | In/out lifecycle for modals/popovers | `{@attach motionPopover({ closing: () => !open, onClosed })}` |
| `motionBackdrop(closing, onClosed)` | Backdrop fade paired with popover | `{@attach motionBackdrop(() => !open, onClosed)}` |
| `magneticHighlight(target)` | One highlight that springs between items, iOS-pointer style | `{@attach magneticHighlight(() => activeEl)}` |
| `originBurst(opts)` | Launch items out of a measured point and put them back, iOS-folder style | `{@attach originBurst({ origin, index: i, count, closing })}` |
| `stateEcho(key)` | Instant arrival, decaying trail, for cluster-driven state | `{@attach stateEcho(() => m.kind)}` |
| `overlayMotion(isOpen, opts?)` | Menus, popovers, dropdowns: spring in **and** out | `{@attach overlayMotion(() => open)}` |
| `motionPanel(isActive)` | Entrance for a tab panel that stays mounted | `{@attach motionPanel(() => tabs.value === id)}` |
| `centerOf(el)` | Page-space centre of an element, for an origin | `const origin = () => centerOf(avatarEl)` |
| `pressSpringDelegate(root, sel)` | Delegated hover/press for many children | Called imperatively in `onMount` |
| `motionEnabled()` / `decorativeMotion()` | Tier predicates for imperative code | `if (!motionEnabled()) return;` |

**Rules:**
- Motion communicates state, orientation, and continuity. It does not decorate. No tilt, no rubber-banding, no reacting to how hard the pointer was moving.
- A long CSS `cubic-bezier` is not a slow animation. `cubic-bezier(0.22, 1, 0.36, 1)` over 320ms is 91% complete in 136ms and then crawls: nominally slow, visually instant. Springs spend their time where the eye can see it.
- Never reach for a bezier to avoid a spring's overshoot at a hard floor. Every curve tried front-loaded the same way — `cubic-bezier(0.32, 0.72, 0, 1)` had the header two thirds collapsed inside 70ms. Use `springToFloor`, which keeps the physics and clamps per frame.
- Anything that animates in from `opacity: 0` needs `.motion-entering` applied synchronously and dropped on `finished`. Between mount/reveal and the animation's first sample the element paints at full opacity for a frame, which reads as a flash.
- Nothing may appear or disappear without an opposing force. If a surface has an entrance it must have an exit; `display: none` is not a dismissal.
- Never animate a status *into* view. Reality-driven state is instant; animate its trail.
- Anything animating to a hard floor (`height: 0`) must not use a plain bouncy spring. The undershoot goes negative, the browser discards every invalid write, and the box freezes at its last valid value before snapping shut. Use `springToFloor`, which drives the spring itself and clamps per frame, so the physics survive.
- Motion keeps ownership of every property it has animated on an element and re-applies its last value when the next animation starts on that element. If a property needs to be reset outside an animation, never animate it at all — set it directly. Animating `padding` on close is what left it at 0.9px through the following open.

  This bites hardest when only *one* direction uses Motion. `springCollapse`'s expand animated `height` as an element property while its collapse wrote height directly; starting the collapse's opacity animation made Motion re-apply the remembered expanded height, and the header sprang back open a beat after closing. Both directions now drive height as a plain value through `onUpdate`, so Motion never owns it. **If a property is ever written outside an animation, no animation on that element may own it either.**
- `pnpm build` does **not** catch undefined identifiers in `.svelte.ts` modules — it compiles and ships a `ReferenceError` that blanks the page. After editing `motion.svelte.ts`, load a real page and confirm it renders.
- Never compose two springs writing the same transform axis.
- Stagger stride is 25ms and total delay is capped at 200ms, so long lists do not trail off.

### When to use what

- **Interactive element (button, card, link):** `springHover` — 2px lift on hover, constant press scale
- **List of items appearing:** `motionStagger` with `index` — never pass `stride`, the 25ms default is the demo's
- **`originBurst` on a group:** never pass `stride` either. It derives one from `BURST_WINDOW` so a 2-tile and an 11-tile group take the same time; a fixed per-item stride turns a long list into a slow top-to-bottom wave
- **Expand/collapse content:** `springCollapse`
- **Toggle indicator (chevron, arrow):** `springRotate`
- **Modal/popover lifecycle:** `motionPopover` + `motionBackdrop` with render-flag pattern
- **Selection moving between items (tabs, menus, segments):** `magneticHighlight`
- **A group revealing out of the thing you clicked:** `originBurst` with that thing's centre as `origin`
- **Numeric value change:** `animate(0, target, { ...transition('smooth'), onUpdate })`
- **Ambient loops (pulse, breathing):** CSS `@keyframes` only — Motion is for state transitions

### Animated icons (`@jis3r/icons`)

These icons have built-in hover animations. To trigger animation from a parent element instead of the icon itself:

1. Track hover state on the parent: `onmouseenter={() => (hovered = true)}`
2. Pass to icon through the tier gate: `<Unplug size={14} animate={iconAnimation(hovered)} />`
3. Wrap icon in `pointer-events: none` span to prevent its internal handlers from fighting

The animations are plain CSS inside the package and their end state is a static transform, so
the tier rules in `tokens.css` only shorten the transition — the icon still snaps into its
animated pose. Icon flourishes are decoration, so they must never enter that state below `full`:
every `animate` prop goes through `iconAnimation()`, and `tokens.css` takes the wrappers out of
hit testing below `full` so the icon's own `mouseenter` cannot fire either. Any code that
synthesises `mouseenter` on an icon to forward parent hover must check `decorativeMotion()`.

For snippet-based components, pass hover as a snippet parameter. `SettingsSection` and
`IconButton` already run their flag through `iconAnimation()` before handing it over, so the
snippet passes it straight to the icon:
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
