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

All interactive animation uses spring physics from `motion`. CSS `transition` is only for color/opacity on hover states. Any movement, scaling, or layout change must go through a Motion spring.

### Orchard curves (one table, one tempo)

Every curve in the app comes from `CURVES` in `src/lib/design/springs.ts`, described as a **response** (seconds, the spring's period) and a **damping ratio** (1 = no overshoot, lower = more bounce). `pnpm gen:design` turns the table into CSS tokens in `src/lib/design/springs.css`. **Never write stiffness, damping, mass, cubic-bezier or a millisecond duration for interaction motion in a component. Name a curve.**

| Name | response | damping | Use for |
|---|---|---|---|
| `snap` | 0.22 | 0.88 | anything that opens or expands: folders, dropdowns, menus, popovers, panels |
| `pop` | 0.24 | 0.78 | things appearing: staggered rows, fan buttons, buds, badges |
| `settle` | 0.17 | 1 | closing, exits, collapses (never bounces) |
| `glide` | 0.28 | 0.92 | highlights, carets, scrubbers, sliding indicators, hover lift, height and position changes |
| `press` | 0.12 | 1 | press feedback |
| `morph` | 0.3 | 0.8 | shape morphs: toast, notifier island, liquid button and menu |
| `bouncy` | 0.32 | 0.6 | rare celebratory one-shots |
| `cinematic` | 0.7 | 0.86 | full-viewport choreography seen once |

`smooth`, `snappy` and `interactive` are aliases for `glide`, `snap` and `press`.

**Tempo.** `TEMPO` in `springs.ts` (CSS `--tempo`) scales every curve's time at once without changing its shape; `setTempo()` changes it at runtime (the Experiments panel has a slider). To make the whole app snappier or calmer, change that one number. To retune one kind of motion everywhere, change its row in `CURVES`.

**Using them.**
- CSS: `transition: transform var(--spring-snap-duration) var(--spring-snap)`; exits use `--spring-<name>-exit(-duration)`.
- Fades: `opacity var(--fade-in) var(--curve-out)`, `var(--fade-out) var(--curve-in)`, `var(--fade-long)`.
- WAAPI: `el.animate(frames, springTiming('snap', { distance, delay, exit }))` and `fade('in' | 'out' | 'long', delay)`.
- `motion` library: `transition('pop')` or `motion(el, kf, 'pop')`. Hand-rolled rAF springs: `physics(SPRINGS.glide)`.
- Distance: pass `distance` (px) and the curve is paced by `pace()`, √(distance / 420) clamped to 0.55–1.6, so a small folder and a big one move at a similar speed.

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

### What moves, what doesn't

The full table is in `DESIGN.md` (Motion). The rule behind it:

- **Moves:** anything the user caused that changes space. Overlays open and close (`overlayMotion`, from the side they actually opened on). Selection indicators glide. Rows the user adds or removes go through `in:presence out:presence` (keyed `{#each}`, stable key, never the index): the space opens on `glide` with content popping in 50ms behind; on removal content fades and the space closes on `settle`. Content swaps go through `Swap` (old leaves at once, new rises in, the box morphs height). Disclosures collapse. Presses scale on `press`, except popover triggers, disclosure summaries and menu rows, which tint (a scaled trigger is what the popover measures).
- **Instant:** reality-driven state (`stateEcho` trail only), typing and what it filters (no per-keystroke stagger, no spring on the panel height), focus rings, highlight inside an open menu, values in repeated input (stepper clicks, arrowing through tabs), spinners swapping in, content replacing a skeleton, and the first render of anything.
- **Every entrance has an exit.** A row the user deleted never vanishes and its gap never jumps shut. In a swap the outgoing half is instant on purpose: two panels sharing the layout is the jump this rule forbids, and the height morph carries the continuity.
- `presence` handles a flex-column parent's `gap` itself (it animates the edge margin from `-gap`), so a row leaving a `gap` stack does not leave a 6px step behind. It skips the first render because Svelte local transitions only run when their own block changes.
- `ListRow`/`EntityRow` take `presence` as an opt-in: the kit cannot tell a row the user added from one a refetch delivered.

### Overlays

Every transient surface — `Menu`, `PopoverPanel`, and anything built on them — goes through `overlayMotion`. It replaced a 130ms CSS keyframe that had **no exit at all**, because the same rule that hid the panel used `display: none`, so panels vanished rather than dismissed.

Two constraints come from these being native popovers:

- the element is not in the top layer until the library calls `showPopover()`, which happens *after* the Svelte effect. Animating immediately runs against a non-rendered element and completes instantly, so the entrance is deferred one frame.
- the library rewrites the element's `style` attribute while positioning it, so an inline "start hidden" seed is gone by the next frame. The closed state is seeded with the `.motion-entering` class instead, dropped once the animation owns the property.

**Interruptibility**: a fresh open passes explicit `[from, to]` keyframes, but an interrupted one passes **targets only**, so the spring continues from the live on-screen values instead of snapping back to the start. Reversing a half-open menu picks up where it actually is.

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
| `magneticHighlight(target)` | One highlight that springs between items like a pointer | `{@attach magneticHighlight(() => activeEl)}` |
| `originBurst(opts)` | Launch items out of a measured point and put them back, like a folder opening | `{@attach originBurst({ origin, index: i, count, closing })}` |
| `stateEcho(key)` | Instant arrival, decaying trail, for cluster-driven state | `{@attach stateEcho(() => m.kind)}` |
| `overlayMotion(isOpen, opts?)` | Menus, popovers, dropdowns: spring in **and** out | `{@attach overlayMotion(() => open)}` |
| `motionPanel(isActive)` | Entrance for a tab panel that stays mounted | `{@attach motionPanel(() => tabs.value === id)}` |
| `centerOf(el)` | Page-space centre of an element, for an origin | `const origin = () => centerOf(avatarEl)` |
| `springProgress(name, opts?)` | A named spring sampled as progress over time, for Svelte transitions | `springProgress('glide').at(ms)` |
| `presence` (`$lib/utils/transitions`) | In-flow enter and exit that opens and closes its own space | `<div in:presence out:presence>` |
| `swap` (`$lib/utils/transitions`) | Incoming half of a content swap; use the `Swap` component | `<Swap key={tab}>…</Swap>` |
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
- A surface that switches between two layouts (the project hero going from spotlight to banner) morphs with a view transition, never a height animation plus cross-faded copies. Start it in `onNavigate`, put a class on `<html>` for the duration and hang every `view-transition-name` off that class so the names never exist at rest. Shrink-wrap named text (`width: fit-content`) or the group scales it by the box width, keep the taller snapshot underneath at full opacity with the shorter one fading on top, and give the group the shadow the snapshots cannot keep. Chrome ignores `mask` on `::view-transition-group`, so a masked edge (the glass rim) goes on `::view-transition-image-pair` of a named stand-in element. The default `plus-lighter` blend adds the two snapshots together; set `mix-blend-mode: normal` whenever one of them stays opaque.
- Art and canvases inside something the sidebar resizes are sized off the viewport, not their container, so a sidebar toggle only moves the crop. A `ResizeObserver` that reallocates a WebGL buffer is debounced.
- Stagger stride is 25ms and total delay is capped at 200ms, so long lists do not trail off.

### When to use what

- **Interactive element (button, card, link):** `springHover` — 2px lift on hover, constant press scale
- **List of items appearing:** `motionStagger` with `index` — never pass `stride`, the 25ms default is the demo's
- **`originBurst` on a group:** never pass `stride` either. It derives one from `BURST_WINDOW` so a 2-tile and an 11-tile group take the same time; a fixed per-item stride turns a long list into a slow top-to-bottom wave
- **Expand/collapse content:** `springCollapse`
- **Row the user adds or deletes:** `in:presence out:presence` on the keyed `{#each}` item, or `ListRow presence`
- **Content that changes with a choice (tab, segment, source):** `Swap` with the choice as `key`
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

## Sound

Interaction sounds come from `cuelume`, imported in exactly one place: `$lib/utils/sound.ts`.
Everything else calls `cue(name)`, which checks the user's Sound setting (Accessibility,
off by default) and a per-cue 2s gate so a burst of SSE events cannot stack.

A cue is reserved for something that **finished happening to a thing you were waiting on**:
a build succeeding or failing on the app on screen, or one this browser started. Never
hover, press, toggle, palette open, navigation, pod transitions, or rows arriving. Those
would train people to mute the whole thing. Sound is never the only channel for a change.

A background tab is where cues matter most, so `cue()` does not check page visibility.
Browser autoplay policy means the first sound needs a gesture, which is why switching the
setting on plays a preview.

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

- Tabs (`PageTabs`, `?tab=`): Overview, Variables, Activity (`deploys`), Observe, Network, Settings
  (`SettingsRail`, `?s=`). Old ids (`metrics`, `environment`, `resources`, `volumes`, `build`,
  `advanced`) still resolve.
- Overview fills exactly one viewport at 64rem wide and 40rem tall or more (`dep-shell--fit`): the
  console takes the main column at full height; the side column (1.618 : 1) stacks `PodsList` (one
  `IslandPill` per pod that opens in place, replicas in a popover), `UsageCard` (CPU and memory against their limits,
  sparklines seeded from `/metrics` then extended by SSE) and `ErrorsCard` (the 5xx error rate and
  its trend from `/observe/.../http-metrics`, when the app serves HTTP). Add `?guides=1` to
  draw the golden-ratio `GoldenReticle` over the page when checking alignment. Below that size it scrolls. Nodes and
  other infrastructure stay hidden.
- Problems show as one `AlertStack` line above the panels; it expands to the full list.
- Live values land instantly; motion is the decorative layer on top (`NumberRoll`, `stateEcho` on pod
  status, the sparkline growing), never a tween that delays the number.
- `NextSteps` is a "Set up" button with a progress ring in the header, opening a popover.
- `DeploymentAlerts` feeds `AlertStack` with build failures, pod crashes, resource pressure and SSE
  disconnect; `humanizeWarning()` in `$lib/utils/format.ts` writes the copy.
- SSE drives real-time updates; TanStack Query with adaptive polling as fallback.

## Running without a backend

`pnpm dev:mock` (from here or the repo root) starts Vite with `ORCHARD_MOCK=1`, which mounts the
`mockApi()` plugin from `mock/plugin.ts`. It answers every `/apiv1/*` request from an in-memory
store, so the real app runs with no Nest server, Postgres, Redis, Kubernetes or gateway. You are
signed in as `alfd`, with two orgs (`ysws`, `hq`), the projects from `src/routes/dev/ui/fixtures.ts`,
and deployments, databases and jobs in mixed states (running, building, crashing, stopped,
provisioning).

- **Live:** the org SSE stream (`/apiv1/events/orgs/:id`) emits the same `{ type, id, projectId, payload, ts }`
  events as the server, so redeploys, restarts, scaling, env edits, job runs and backups update the UI on
  their own. A redeploy walks queued, cloning, building, pushing, deploying, running over about 20s.
  The Observe log stream, build log stream and pod shell (`ws`, a toy shell) work too.
- **Pod states:** every pod can be put into a Kubernetes scenario (crash loop, out of memory, image pull
  failure, missing secret, unschedulable, failing readiness, terminating, evicted) from the flask
  button on an app's Pods card, or `POST /apiv1/__mock/deployments/:id/pods` with `{ scenario, index? }`.
  `mock/scenarios.ts` produces the same status, termination, warnings and events the server does, so
  alerts and pod labels behave as they will in production. `__ORCHARD_MOCK__` is true only in mock mode.
- **Sign out** makes every non-auth route 401 until you click "Continue as alfd (mock)" on the login
  page (any email and 6-digit code also work).
- **Data** is seeded in `mock/seed.ts` (entity types in `mock/types.ts`). State lives in `mock/store.ts`,
  which also owns the mutations and the build simulation. It resets whenever Vite restarts, and Vite
  restarts whenever a file in `mock/` changes.
- **Routes** live in `mock/routes/*.ts`, grouped by page. Add one with
  `r.get('/things/:id', ({ params, query, body }) => ...)`: return a value for 200 JSON,
  `reply(status, body)` or `notFound()` for anything else. Serialize through `mock/serialize.ts` so shapes
  stay in step with the server (check `packages/contracts/src/schemas` and the Nest controller).
  The most specific pattern wins, so registration order does not matter.
- **Gaps:** an unhandled GET answers `[]` and an unhandled mutation answers `{ ok: true }`, and both are
  logged once as `[mock] unhandled METHOD /apiv1/...` in the Vite console. That line is the to-do list.
- `ORCHARD_MOCK_LATENCY=300` adds latency to every response. Mock mode uses its own Vite cache
  (`node_modules/.vite-mock`) so switching between `dev` and `dev:mock` does not re-optimize deps.

`mock/` is outside `src/`, so none of it ships.

## File organization

- Routes: `src/routes/`
- Shared components: `src/lib/components/`
- Feature components: `src/lib/components/<feature>/` with `index.ts` barrel export
- Utilities: `src/lib/utils/`
- Stores: `src/lib/stores/`
