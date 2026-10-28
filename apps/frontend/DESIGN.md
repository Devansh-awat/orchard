# Orchard UI 3.0

Everything a screen needs is in `src/lib/components/ui` (primitives) and
`src/lib/components/patterns` (recipes). The living catalogue is `/dev/ui` (run
`pnpm dev`, open `localhost:3000/dev/ui`). If a screen needs something that is not in the
catalogue, add it to the kit and the catalogue first; never hand-roll it in a route.

## Constitution

1. One way to do each thing. Every need maps to exactly one component.
2. Space comes from the 4px grid: Tailwind `0.5 1 2 3 4 6 8 12 16` only. A container's
   padding is at least 1.5x the gap between its children. Gaps between groups are about
   2x the gaps inside a group.
3. Hierarchy comes from weight and tone, not size. Three weights (450, 550, 650), three
   text tones (`fg`, `muted`, `faint`).
4. Colour means something. Neutral surfaces with the theme tint, one accent, status
   colours only for status. Status is never colour alone.
5. One representation per entity. A deployment, database or job always renders through
   `EntityRow`. Everything else is progressive disclosure.
6. Motion is physics, and only transform and opacity move. Named springs only.
7. Glass is for floating chrome only (menus, popovers, toasts, command menu).
8. Spend novelty on deploy moments and project identity (aura, toasts). Everything
   else is quiet on purpose.
9. Every word earns its place. Copy that does not change what someone does or knows
   is cut, not toned down.

## Copy that earns its place

Before adding a subtitle, hint or note, ask what someone would do differently after
reading it. If the answer is nothing, delete it.

- **Cut reassurance.** "Takes about a minute. Everything stays editable afterwards."
  The progress UI shows how long it takes; editability is assumed.
- **Cut restated titles.** A "Configure" card does not need "Applied when it deploys".
  A "What gets created" list does not need "Everything lands in this project".
- **Keep consequences.** "Leave them empty and Orchard generates strong values" changes
  behaviour, so it stays. So does "Org defaults if you skip this".
- **Keep the specific.** A hint that names a real value (`ysws_hackclub_site_name`,
  "17 is the recommended default") beats one that describes the field.
- One line, sentence case, no trailing marketing. If a hint needs two sentences, the
  field probably needs a better label or a default.

## Avoiding AI tells

AI-built UI averages its training data. These are the tells people notice, and the
rule for each:

- **Cards inside cards.** Nest only when elevation means something: a sunken tray holding
  raised cards, never a bordered card inside a bordered card.
- **The same chrome on every repeated item.** Show status in words ("1 failing"), and put
  per-item actions on hover. One primary action per page.
- **Decorative colour.** Red only means broken, amber only in progress, green only healthy.
  Identity colours (app icons) never use red.
- **One radius everywhere.** Containers 18, cards 12, controls 10, inner tiles 8.
- **Fake people and fake art.** Use the real org logo, avatars and project icons; fall back
  to a glyph, never a lone letter.
- **Generic copy.** Say what is true right now ("Everything is running except 3 apps").

## Why it looks expensive (do all of these)

- **Optical alignment.** Icons centre on the text's cap height, not its line box. Text
  that sits next to an icon, or inside a pill, uses `text-box: trim-both cap alphabetic`
  so padding is measured from the ink. Verify with `/dev/ui` and the alignment audit
  (`.context`-style script: icon centre vs cap centre, delta 0).
- **Continuous corners, not circles.** Every rounded rectangle writes
  `border-radius: calc(R * var(--corner-scale)); corner-shape: var(--corner);` where R is
  the nominal radius (`--radius-control` 10px, `--radius-card` 14px,
  `--radius-panel` 18px). `--corner` is `superellipse(1.4)` and `--corner-scale` is 1.25,
  fitted by pixel diff against Figma's 60% corner smoothing; plain
  `squircle` at the same radius reads boxy. Browsers without `corner-shape` fall back to
  round corners at scale 1. Circles only for status dots, radios and the switch; capsules
  only for the toast.
- **Dense, not big.** It is a developer tool: 32px controls, 36px nav rows, 14px body.
- **Concentric corners.** Inner radius = outer radius minus inset. A circle inside a
  capsule sits at an inset equal to `(height - circle) / 2`. Never nest equal radii.
- **Hairlines, not borders.** 0.5px to 1px rings in `--border-default`, drawn once.
  Elevation is a ring plus a soft layered shadow, never a hard 1px grey box.
- **Light from above.** Raised controls get a faint top inner highlight
  (`inset 0 1px 0 rgb(255 255 255 / 0.12)`) and a small drop shadow. Pressed controls
  scale to 0.97.
- **Restraint.** One primary button per view. Colour only where it means something.
  Generous whitespace. Muted secondary text.
- **Numbers are tabular** (`font-variant-numeric: tabular-nums`) everywhere they change.
- **Every state is designed:** rest, hover, pressed, focus-visible, disabled, loading,
  empty, error. Focus is a soft 3px accent ring, never the browser outline.
- **Motion is interruptible and staged.** Shape first, content after. Closes settle
  flat (no bounce). Nothing teleports: if a thing leaves a list, the gap closes with it.

## Tokens (`src/lib/design/`)

- `scales.css` is generated (`pnpm gen:design`) from the theme engine: `--neutral-*`,
  `--accent-*`, `--red-*`, `--amber-*`, `--green-*`, `--blue-*`, steps 1 to 10, plus
  `-contrast` (text on step 7). The theme store repaints them live.
- Step meanings: 1 component bg, 2 hover bg, 3 active bg, 4 border, 5 hover border,
  6 active border, 7 solid fill, 8 solid hover, 9 secondary text, 10 primary text.
- Roles (`tokens.css`): `--bg-app` (tinted frame), `--bg-sheet` (content sheet),
  `--bg-surface`, `--bg-raised`, `--bg-sunken`, `--bg-hover`, `--bg-active`,
  `--text-default|muted|faint|link`, `--border-default|strong`, `--accent`,
  `--status-{kind}` (text), `-solid`, `-bg`, `-border`, `--shadow-raised|floating|overlay`,
  `--material-glass-*`, `--radius-control|card|panel`, `--weight-*`, `--z-*`,
  `--page-narrow|default|wide`.
- Tailwind utilities on top: `text-fg/muted/faint`, `bg-app/sheet/surface/raised/sunken/
hover/active`, `border-edge`, `text-accent`, `bg-accent-soft`, `text-success` (and
  `-soft` backgrounds), type roles `text-display|title-1|title-2|title-3|headline|body|
callout|caption|micro`, `rounded-control|card|panel`.
- Fonts: Plus Jakarta Sans (UI), JetBrains Mono (code, logs, IDs).

## Which component

| Need                                                        | Use                                                                                                                                                     |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App layout                                                  | `AppFrame` (sidebar, backdrop, content) + `Sidebar` (org, search, sections, user)                                                                       |
| Page                                                        | `Page` (title, description, eyebrow, actions, aside, hero, header, footer, width)                                                                       |
| Small heading above a group                                 | `SectionTitle` (title, count, actions, size)                                                                                                            |
| Group of content                                            | `SectionCard` (title, description, actions, footer, flush)                                                                                              |
| Plain container                                             | `Card` (`href`/`onclick` makes it interactive)                                                                                                          |
| A project and its resources                                 | `ProjectGroup` (baked aura header) + `EntityCard` grid                                                                                                  |
| Project page header                                         | `ProjectHero` over `ProjectBackdrop` (live aura)                                                                                                        |
| Rows of things                                              | `List` + `ListRow`; dense resource lists use `EntityRow`                                                                                                |
| Things deployed together (compose stacks)                   | `StackRow` in a `List`: each service as dot and name in the detail line, failing ones first; a failed stack shows its error there instead               |
| Table of data                                               | `Table`                                                                                                                                                 |
| Numbers                                                     | `Metric`, with `Sparkline` in its `chart` slot; gauges: `Ring`                                                                                          |
| Inline facts (url, branch, commit)                          | `MetaList`                                                                                                                                              |
| Action                                                      | `Button` (primary, secondary, ghost, danger, media; `icon`, `iconRight`, `loading`)                                                                     |
| Actions on a thing                                          | `Menu` + `MenuItem` (+ `MenuHeader`, `MenuLabel`, `MenuSeparator`; `size="lg"`)                                                                         |
| Pick a value                                                | `Dropdown` (default), `SearchPicker` (long list with search), `Combobox` (type-to-filter field)                                                         |
| Add people (members, invites)                               | `Combobox` + `creatable` (invite by email) and `Avatar` in `leading`, role `Dropdown` beside it; each member a `ListRow`, role `Dropdown` in `actions`  |
| Very long plain list                                        | `Select` (native OS menu, only when nobody needs to search)                                                                                             |
| Text entry                                                  | `Field` + `Input` (`suffix`, `mono`, `width="short"`) / `Textarea`; numbers: `Stepper`; ranges: `Slider`                                                |
| On or off                                                   | `Switch`, `ToggleRow` for settings rows, `Checkbox` in lists                                                                                            |
| A setting that is one action (transfer, move, delete)       | `ActionRow` (label, hint, the button); stack them in a `SectionCard`. Delete uses `Button variant="danger"`, never a red-bordered box                   |
| Upload an image (icon, background)                          | `ImageField` inside a `Field`: preview well (`square` or `wide`), Upload/Replace and Remove, `upload` returns the stored URL                            |
| One of few                                                  | `SegmentedControl`; one of many in a form: `RadioGroup` (list or cards)                                                                                 |
| Sections of a page                                          | `Tabs`; location: `Breadcrumbs`                                                                                                                         |
| Sidebar link                                                | `NavItem`                                                                                                                                               |
| Identity                                                    | `Monogram`, `Avatar`, `AvatarStack`, `Aura`                                                                                                             |
| Something happened                                          | `toasts.add()` (see Toasts)                                                                                                                             |
| Something is wrong here                                     | `Alert`                                                                                                                                                 |
| Status                                                      | `StatusBadge`, `StatusDot` via `ui/status.ts` only                                                                                                      |
| Label that is not status                                    | `Badge`                                                                                                                                                 |
| Short hint                                                  | `Tooltip`                                                                                                                                               |
| Floating panel                                              | `PopoverPanel`                                                                                                                                          |
| Dialog                                                      | `Modal`; destructive confirm: `ConfirmModal`                                                                                                            |
| Side panel for create/edit                                  | `Sheet`                                                                                                                                                 |
| Command palette                                             | `CommandMenu`                                                                                                                                           |
| Loading                                                     | `Skeleton`, `Spinner`, `Progress`; build steps: `StepRail`                                                                                              |
| Nothing here                                                | `EmptyState` (always with an action)                                                                                                                    |
| Code and config                                             | `CodeBlock`, `Snippet` (one command), `EnvVarRow`, `LogViewer`                                                                                          |
| Keys, IDs                                                   | `Kbd`, `CopyButton`, `MiddleTruncate` (hashes and IDs only)                                                                                             |
| Times                                                       | `RelativeTime`                                                                                                                                          |
| Product or template page header                             | `ProductHeader` (icon tile, eyebrow, title, description, meta and actions)                                                                              |
| Vertical rhythm                                             | `Stack` (gap `xs` to `xl` on the space scale, `sticky` for side columns)                                                                                |
| End of a form                                               | `FormActions` (Cancel, then the primary action, right-aligned)                                                                                          |
| Password or key field                                       | `SecretInput` (masked, reveal toggle, mono when shown)                                                                                                  |
| A template or schema parameter                              | `ParamField` (picks the control from the parameter type, validates with `paramProblem`)                                                                 |
| What something creates                                      | `ResourceList` (app, database, job, public URL rows)                                                                                                    |
| Optional settings in a form                                 | `Disclosure` (title, note, spring collapse)                                                                                                             |
| Content that changes with a choice                          | `Swap` (`key` is the choice; new content rises in, the box morphs its height)                                                                           |
| Picker that shows its value                                 | `Menu` with a `SelectTrigger` (prefix, value, leading icon, clear)                                                                                      |
| Pickers in a form grid or aside                             | Every picker passes `block`, so account, repo, branch, project and environment fill their cell alike                                                    |
| An amount with a budget                                     | `AmountSlider`: doubling scale that ends at the limit, typed amounts, org default and usage on the track                                                |
| A media slab (hero art, spotlight, banner)                  | No ring and no border: `box-shadow: var(--shadow-glass)` for lift, plus a `::after` with `var(--bevel-glass)` for the lit top edge                      |
| Section switcher inside a page                              | `Tabs` (quiet labels, sliding bar, counts). `UnderlineTabs` only where a toolbar card is wanted                                                         |
| Problems on a page                                          | One alerts card (`Anomalies` with `extra` for plain status failures); never a second Needs attention list beside it                                     |
| Repeating rows the user adds and removes (ports, volumes)   | `RowList`: column headers, stable `key`, rows enter and leave with `presence`, remove and Add built in. Column widths are rem, fr or minmax, never auto |
| A list of folded settings                                   | `DisclosureGroup` around `Disclosure`s; it draws the hairlines, so no `Divider` between them                                                            |
| Two fields side by side                                     | `FieldGrid` (`even` or `golden`); collapses to one column in narrow containers                                                                          |
| A label-left field whose control should line up across rows | `Field layout="row" split`: the control takes the golden 61.8%                                                                                          |
| A dropdown in a form                                        | `Dropdown size="lg"`, with `loading` while options are detected and `mono` for paths; no custom trigger snippet needed                                  |
| A git host                                                  | `GitHostMark` with `gitHostOf(provider, host)`; brand colours are `--mark-*` tokens. Menu rows showing a glyph pass `plain` so no avatar tile is drawn  |
| Where code comes from                                       | `SourcePath`: `owner / repo` at `lg` is the one decision, branch and framework sit under it as `sm` chips                                               |
| Settings in a create flow                                   | Open card for what people set every time, `Disclosure` with a value note under **Advanced** for the rest                                                |
| Featured banner                                             | `FeatureHero` (rotating, icon-baked backdrop, one call to action)                                                                                       |
| Ways to start something                                     | `Dock` (big source tiles in one tray, `busy` while routing)                                                                                             |
| Row of things to pick                                       | `Shelf` (16:9 tiles, `onSelect` to run work before navigating)                                                                                          |
| Separator                                                   | `Divider` (`label="or"` between two ways to do one thing)                                                                                               |
| Icon square                                                 | `ToneTile` (status tone or `accent`, `solid` for done states)                                                                                           |
| One-time code                                               | `CodeInput` (one real input, six cells, submits itself, shakes on error)                                                                                |
| Sign-in or other arrival screen                             | `AuthShell` (field, vine, sheet that morphs its height) + `SignInFlow`                                                                                  |
| Ornament                                                    | `AsciiVine`, only where `The vine` allows                                                                                                               |

## Bold budget

Semibold is spent, not sprinkled. A screen gets one or two semibold things: the page title, and anything that is genuinely wrong (a failing count, a crashed status). Everything else is regular or medium.

- Widget and section titles: medium.
- Names in lists, rows and cards: regular or medium, never semibold.
- Status labels: regular when healthy, semibold only for failures.
- Owners, counts and metadata: regular, coloured or muted instead of weighted.

If a row looks flat without bold, fix it with size, tone or spacing first.

One exception: the brand hero in `AuthShell` (sign-in) speaks like orchard.my, a lowercase
medium headline with one italic word at `--weight-display` (800). That weight exists for
that headline and nowhere else.

## Concentric corners

A surface nested inside another, close to its corner, uses **inner radius = outer radius − the gap between them**, never its own number. Subtract first, then scale: `calc((var(--outer-r) - var(--gap)) * var(--corner-scale))`, with `corner-shape: var(--corner)`. Floor at `--radius-floor` (0.25rem) when the gap is larger than the radius.

- Containers publish their radius and padding as variables (`--widget-r`/`--widget-pad`, `--project-r`/`--tray-pad`, the sidebar's `--nav-radius`, the palette's `--R`/`--inner`) and children derive from them.
- When the padding is big, grow the outer radius from the inner one instead (`--project-r: calc(var(--card-r) + var(--tray-pad))`), so cards keep their shape.
- App icons, avatars and status dots keep their own shape. The rule is for backgrounds: rows, cards, hover fills, thumbs, keycaps, nested panels.

## Highlights never touch

Any list where one row can be selected while another is hovered (sidebar, settings rail, segmented lists) keeps at least `0.25rem` between rows. Two filled backgrounds touching read as one blob, and the hover looks like it is pushing into the selected row.

## Alignment grid

Lay a component out on an explicit grid before styling it, and check it with a reticule (measured offsets, not by eye):

- One padding value all round inside a card (12px for toasts and compact cards).
- A shared text column: every line of text in a block starts at the same x (toast: icon at 12, text at 44).
- Read top to bottom: title first, detail under it, even when the surface grows upward from a bottom anchor.
- Size to content: a one-line note gets a one-line card, not a fixed minimum.
- Columns of status in a list share a fixed-width, left-aligned column so dots and labels line up.

## Live status

Something in progress shows a tiny activity ring (solid core, thin ring, a short arc orbiting it), never a radar ping or pulsing halo. Healthy dots are still. The ring keeps turning at reduced motion because it is a progress indicator.

## Hover-revealed actions

Actions that appear on hover (project + and →, the card's corner fan) show on `:hover` and on `:has(:focus-visible)`, never `:focus-within`, so a mouse click does not leave them stuck on screen. They stay open while their menu is open.

## Focus rings

Inside anything that scrolls or clips (sidebar, lists, panels), focus rings sit inside the element (`outline-offset: -2px`) so the scroll container never cuts them.

## Class names

Scoped classes must not reuse legacy global names (`btn`, `card`, `badge`, `input`,
`alert`, `dropdown`, `skeleton`, `page`) or Tailwind utility names (`group`, `grid`,
`ring`, `collapse`, `table`, `block`, `hidden`, `contents`, `container`, `border`,
`shadow`, `rounded`, `truncate`, `static`, `fixed`, `sticky`, `relative`, `isolate`).
Tailwind generates real CSS for any of those it sees in markup.

## The vine

`AsciiVine` is the only ornament in Orchard: a monospace vine drawn on a canvas at 14
frames a second that grows, sways and blooms. It is the brand mark in motion, so it is
rationed.

- One per screen, and only on arrival screens: sign-in, the updates sheet, a first
  empty project. Never on a screen people work in.
- It threads behind solid surfaces. Copy always sits on a surface, never on the vine.
- It grows once on arrival. `bloom` flowers it when the thing the person came for
  worked (signing in), and nowhere else.
- Its ink is `--accent-6` to `--accent-10`, so a brand colour recolours it. Never pass
  it a colour.
- It is decoration: below `full` motion it is drawn grown and still, and it stops
  drawing off screen and in hidden tabs.

On a brand field (the sign-in hero) its ink switches to cream and white and its glyphs to
Space Mono, matching the vine on orchard.my. `AuthShell` places it. Live reference at `/dev/ui#vine`; every sign-in state at
`/dev/ui/lab/sign-in`.

## Toasts

`toasts.add({ title, description?, color, action?, position? })` and
`toasts.promise(work, { loading, success, error })`. Titles are short and past tense
for results ("Changes saved"). Titles are never coloured: they use `--toast-ink` on the
capsule, and status lives only in the glyph, a solid status fill with a white (`--on-solid`) glyph.
Coloured text on a dark capsule fails contrast. Position follows context: results of something the user
clicked go `bottom-right` (default); things that happened on their own (a build
finishing, connection lost) go `top-center`.

## Truncation

Names and URLs truncate at the end. Middle truncation only for hashes, IDs and file
paths, where the end is what tells two values apart.

## Performance rules

- Never `background-attachment: fixed`, never `backdrop-filter` on scrolling content.
- Shadows never transition. Hover lift fades a pre-rendered shadow layer's opacity.
- Lists past ~50 rows rely on `content-visibility` (built into `ListRow`).
- Shaders run once per screen at most; lists use a baked still (`Aura` with `still`).

## Motion

One curve table, `CURVES` in `src/lib/design/springs.ts`: `snap` (opens), `pop` (appears),
`settle` (closes), `glide` (moves and highlights), `press`, `morph` (shape changes), `bouncy`,
`cinematic`. Each is a response plus damping ratio, mirrored as CSS tokens
(`--spring-{name}`, `--spring-{name}-duration`, `--fade-in/out/long`, `--curve-out/in`) by
`pnpm gen:design`. One `TEMPO` (CSS `--tempo`) scales them all. Never write stiffness, damping,
cubic-bezier or raw durations for interaction motion in a component. See `CLAUDE.md`.

### What moves, what doesn't

Motion when the **user caused a spatial change**: something opens, appears, leaves, reorders,
changes size, or gets pressed. Instant when **reality caused it** (the cluster, SSE, a refetch),
when it is a **text or value edit while typing**, for **focus**, and for anything repeated fast
enough that motion turns into latency. Every entrance has an exit. A removal animates out and its
space closes on a height spring; nothing vanishes and no gap jumps shut.

| Interaction                                                | Motion                                                                                      | Where it lives                                 |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Menu, dropdown, popover, search picker, combobox           | `snap` in from the side it opened on, `snap` out toward it                                  | `overlayMotion` (Menu, PopoverPanel, Combobox) |
| Modal, sheet                                               | `snap` in, `settle` out, backdrop fades with it                                             | `Modal`, `Sheet`                               |
| Highlight inside an open menu or listbox                   | instant, it follows pointer and keys and a spring would trail them                          | `.ui-menu-item`, `.ui-dropdown-option`         |
| Selection moving (segmented control, tabs)                 | the indicator `glide`s to the new item, labels recolour                                     | `SegmentedControl`, `Tabs`, `UnderlineTabs`    |
| Content swap (tab panel, segmented content, source switch) | old content leaves at once, new rises in on `glide`, the container morphs height on `glide` | `Swap`                                         |
| Row the user adds (env var, port, volume, member)          | space opens on `glide`, content `pop`s in 50ms behind it                                    | `in:presence out:presence`, `ListRow presence` |
| Row the user removes                                       | content fades on `settle`, space closes on `settle` 50ms behind it                          | same                                           |
| Disclosure, collapsible section                            | height on `glide`, chevron rotates on `snap`, collapsed body is inert                       | `Disclosure`                                   |
| Card or panel resizing after a user action                 | height `glide`                                                                              | `Swap`, `morphHeight`                          |
| Validation error                                           | text instant; its line opens and closes with `presence`; hint to error swaps in place       | `Field`                                        |
| Press on buttons, segments, steppers, checkboxes, cards    | `press` scale: 0.96 controls, 0.98 rows, 0.99 cards                                         | component CSS on `--spring-press`              |
| Press on popover triggers, disclosure summary, menu rows   | tint only. The popover measures its trigger, and menu rows close on release                 | `SelectTrigger`, `Disclosure`, menu CSS        |
| Switch, checkbox, radio                                    | thumb `glide`s, mark `pop`s                                                                 | `Switch`, `Checkbox`, `RadioGroup`             |
| Toast                                                      | `morph`                                                                                     | `Notifier`                                     |
| Status, build steps, pods, rows arriving from the cluster  | instant, with a `stateEcho` trail                                                           | `stateEcho`                                    |
| Typing: filtering a list, search results, live validation  | instant. Rows never stagger per keystroke and the panel resizes without a spring            | `SearchPicker`, `Combobox`, `CommandMenu`      |
| Focus ring                                                 | instant                                                                                     |                                                |
| Repeated input (stepper clicks, arrow keys through tabs)   | the value is instant, only the indicator moves                                              |                                                |
| Spinner in a trigger or button                             | instant swap with the chevron or label                                                      | `SelectTrigger`, `Button loading`              |
| Skeleton to content                                        | the skeleton fades in late so fast loads never show it; content replaces it instantly       | `Skeleton`                                     |
| First render of anything                                   | still. `presence` and `Swap` skip the first render; only arrival screens stagger in         |                                                |

`presence` is opt-in on `ListRow`/`EntityRow` because the kit cannot tell a row the user added
from a row a refetch delivered. Pass `presence` where the person on this screen adds or deletes
the rows; leave it off for lists the cluster fills. A keyed `{#each}` needs a stable key (never
the index) or the wrong row leaves.

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
