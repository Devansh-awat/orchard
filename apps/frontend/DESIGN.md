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

## Theme engine (`src/lib/theme/`)

A theme is not a list of hex values. It is a constellation of colour nodes on a unit
square, and every token is generated from it.

```
ThemeSpec { angle, radius, count, blend, grain }  +  scheme (light|dark)
  -> specNodes()            1 to 3 nodes, derived
  -> deriveSimpleColors()   12 editable colours
  -> [user overrides]       "Advanced colours" pins individual values
  -> generateThemeColors()  the ~47 engine tokens app.css expects
  -> generateChrome()       --theme-chrome-image, --theme-grain
```

**The field is polar.** Angle is hue, distance from the centre is saturation, the
conventional colour-wheel layout: grey at the centre, full chroma at the rim, with
`vividnessFor()` curving the ramp (`r ** 0.7`) so most of the disc reads as colour
rather than wash. Putting the saturation peak at the centre instead is what produces a
rainbow singularity there, since every hue converges on one pixel; a grey centre is the
same convergence but the colour they converge on is correct. `nodeSwatch()` and
`fieldFalloff()` share the ramp, so a node always reads as the colour it is sitting on.

**Why nodes only move together.** The spec stores one polar anchor, not a node list.
`specNodes()` spreads the rest evenly around the circle from it (`FANS`): a diameter for
two nodes, an equilateral triad for three. They always sit on opposite sides of the
canvas centre at the same radius, so the shape is symmetric by construction and the hue
relationship is a complement or a triad rather than anything editable. Dragging moves
the anchor; everything else follows.

Two things fall out of the polar form for free. The shape shrinks toward the centre,
because the chord between two points separated by a fixed angle is proportional to the
radius, so saturated themes cluster and washed-out ones spread. And there is no edge to
fall off: hue is cyclic, so the anchor can rotate forever without the constellation
appearing to clone itself across a boundary the way a clamped cartesian field does.

**Blend is scaled by the palette's own vividness.** `tint` and `surfaceShift` both
multiply by `vividness ** 0.6`, so a palette dragged to the rim of the field produces
grey surfaces however high blend is. Without that coupling the surface tint was the one
value in the engine that ignored the nodes entirely, and a constellation of visibly grey
dots still painted a saturated background.

**Blend moves lightness, not just chroma.** sRGB has almost no chroma available at the
top of the lightness range: at L 0.971 a red hue caps out around 0.014, so a blend that
only raised chroma was already clipped at half travel and the top half of the slider did
nothing. `surfaceShift` therefore walks every surface lightness toward the middle as
blend rises (light -0.062, dark +0.075), which is what actually buys the saturation.
`generateThemeColors` recovers that shift from the background's own lightness rather
than the ladder constant, so the rest of the surfaces follow even when the background
has been overridden by hand. `muted` tracks the shift at 0.6 weight so its contrast
against the background stays flat (4.41 to 4.42 across the whole light range) instead of
eroding as the page darkens.

**Why OKLCH.** `LADDERS` in `generate.ts` fixes perceptual lightness per scheme and lets
only hue and chroma come from the spec, so text-on-background contrast is a constant no
matter where the palette is dragged. The same ladder in HSL would wash yellows out and
muddy blues at identical values. `gamutMap()` walks chroma down rather than clipping
RGB, because clipping shifts hue and breaks the harmony the constellation is protecting.

**Chrome.** One node is a flat wash, two or more is a soft mesh gradient. Blob positions
are fixed by node index, not node position, so the composition stays balanced and the
background never lurches while dragging. Anything that paints a full-area background
inside the app shell (`body`, `main`, the mobile drawer) must carry
`var(--theme-grain), var(--theme-chrome-image)` with `background-attachment: fixed`, or
it shows as a hard seam against its neighbours. `html.contrast-high` drops both.

`--theme-chrome-image` expands to **one background layer per node**, so every companion
longhand has to stay a single value (`background-size: auto`, `background-repeat:
repeat`). A two-value list there gets cycled across the extra layers, which sized half
the mesh gradients to the grain tile and rendered the background as 180px squares.

**The wheel is a bare disc.** Drawing it inside a square plate leaves corner geometry
that means nothing, since every position outside the inscribed circle clamps back to
radius 1 and is unreachable. The count stepper sits under the disc rather than floating
inside it for the same reason.

**Classic themes** (`legacy.ts`) are the five hand-authored palettes the engine
replaced, kept as their original twelve hex values applied through the same override
channel the advanced editor uses. Their specs carry `blend: 0`, because those themes
predate the chrome layer and a gradient wash over them is exactly what stops them
looking like themselves. Touching any palette control drops the whole pinned set, since
a Classic theme is a snapshot rather than a starting point; individual pins made by hand
survive, because the store only clears overrides that match a Classic set outright.

The twelve pinned colours reproduce exactly. Tokens derived from them land within
0.04 OKLCH lightness of the originals, and `generateThemeColors` remaps the primary ramp
through the accent's real lightness rather than the ladder's so an overridden accent
keeps its ramp centred on itself. Skipping that remap put Electric's button fill 0.14 L
away from where it used to be.

**Fonts.** `fonts.ts` lists the six interface typefaces; the store writes the chosen
stack to `--font-sans`. Every non-default face carries a `size-adjust` in `app.css`
normalising it against Plus Jakarta Sans. OpenDyslexic also needs ascent and descent
overrides and a heavy size reduction because its advance widths are half again as wide
as the default.

**No flash.** `applyTheme` caches the generated custom-property text for both schemes in
`localStorage['orchard-theme-boot']`; the inline script in `app.html` injects it before
first paint and the store removes that style element once it owns the values.

## Guardrail

`pnpm check:design` (also runs in root `pnpm lint`). Counts hex colors, legacy token
usage, and legacy classes in `.svelte` files against `design-baseline.json`; fails only
on increases. After paying down debt, tighten with `pnpm check:design --update`.
