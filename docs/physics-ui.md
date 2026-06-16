# Physics-Based UI with Motion

A guide for building Apple-grade interactive UIs using `motion` (motion.dev) and the 12 UX-in-Motion principles. Read this before adding animation to a Svelte component in this repo.

## Mental model

**State vs act.** A static comp shows the *state* of an object (open, selected, loading). The *act* of opening, selecting, loading is temporal and is where motion lives. Don't animate states — animate the transitions between them.

**Realtime vs non-realtime.**
- *Realtime* = direct manipulation. The user is touching/dragging/scrolling the object as it moves. Motion must track input with no perceptible lag — use stiff, responsive springs.
- *Non-realtime* = post-interaction transitions. User clicks, then the UI responds. Heavier springs work because the user is now passive.

**Principles vs techniques vs properties vs values.**
- Principle: *why* (e.g. Easing, Parenting, Masking).
- Technique: *how* (a "blurred glass" obscuration).
- Property: *what* (opacity, blur, scale, x).
- Value: *number* (0.7, 25px, 0deg).

When designing, work top-down: pick principles first, choose a technique, then animate the right properties.

**Four jobs of motion in UX:**
1. **Expectation** — narrow the gap between what the user expects and what happens.
2. **Continuity** — preserve flow within and across scenes; never let an object teleport.
3. **Narrative** — give the experience a beginning, middle, end.
4. **Relationship** — show spatial / temporal / hierarchical links between objects.

If an animation doesn't serve at least one of these four, delete it.

## Why Motion (motion.dev), not Svelte's `Spring`

- Real second-order spring physics (mass / stiffness / damping). Svelte's `Spring` is a velocity-decay tween — it does not actually overshoot.
- Velocity-aware interruption: a new `animate()` call inherits the current velocity of the previous one — that's the "Apple feel" when you tap a card mid-animation and it doesn't snap.
- Framework-agnostic, MIT, ~3.8 KB mini.
- API: `animate(target, keyframes, options)`. With `{ type: 'spring', stiffness, damping, mass }` you get real physics.

```ts
import { animate } from 'motion';
animate(el, { y: -4 }, { type: 'spring', stiffness: 360, damping: 22, mass: 0.5 });
```

Returns an `AnimationPlaybackControls` with `.finished` (a Promise) — chain it for sequenced animations and to gate unmounts.

## Spring tuning cheatsheet

The damping ratio ζ = `damping / (2 * sqrt(stiffness * mass))`. Memorize this.

- ζ < 1 → underdamped → overshoots, oscillates. Use for "alive" / playful feedback.
- ζ ≈ 1 → critically damped → fastest settle without oscillation. Use for utilitarian UI.
- ζ > 1 → overdamped → sluggish. Almost never what you want — use eased CSS instead.

| Use case | stiffness | damping | mass | ζ | feel |
|---|---|---|---|---|---|
| Card hover lift | 360 | 22 | 0.5 | ~0.82 | snappy, slight overshoot |
| Tab activation pop | 480 | 16 | 0.9 | ~0.39 | playful bounce |
| Heavy panel collapse | 180 | 19 | 1.3 | ~0.62 | deliberate, slight overshoot |
| Popover open | 520 | 30 | 0.85 | ~0.71 | quick, almost no overshoot |
| Popover close | 570 | 36 | 0.85 | ~0.82 | tighter on exit (feels final) |
| Dot indicator slide | 380 | 22 | 0.7 | ~0.68 | confident |
| Cursor-tracking tilt | 380 | 28 | 0.5 | ~1.02 | critically damped — no jitter |
| Sympathetic shockwave | 220 | 15 | 0.9 | ~0.53 | meaningful wobble |

**Guidelines:**
- Larger objects → higher mass, lower stiffness. Small objects → low mass, high stiffness.
- Realtime tracking (cursor, drag) → ζ near 1.0. Underdamped trackers feel laggy/jittery.
- Exit animations should be ~10–20% stiffer / more damped than entry. The user's done with it; get out of the way.
- Never compose two animate() calls writing the *same* transform component (e.g. two springs both writing `y`). They'll fight. Compose by writing different components: one writes `y` + `scale`, another writes `rotateX` + `rotateY`.

## The 12 principles, mapped to Motion

### 1. Easing — every temporal event eases
Linear motion is the giveaway of an unfinished UI. Spring physics is easing taken seriously: every property change should pass through a spring or a `cubic-bezier(0.22, 1, 0.36, 1)` curve at minimum. **Always.**

```ts
animate(el, { opacity: 1 }, { type: 'spring', stiffness: 300, damping: 28 });
```

### 2. Offset & Delay — stagger to convey separateness
When several new objects appear, delay each by ~30–60ms. Tells the user *before* they read content that the items are independent.

```ts
function motionStagger(opts) {
  const i = opts.index ?? 0;
  const stride = opts.stride ?? 0.05;
  return (el) => {
    animate(el, { opacity: [0, 1], y: [10, 0], scale: [0.985, 1] },
      { type: 'spring', stiffness: 260, damping: 22, mass: 0.9, delay: i * stride });
  };
}
```

Apply with `{@attach motionStagger({ index: i })}` inside an `{#each}`.

### 3. Parenting — link properties between objects
A child property responds to a parent's property change. Three flavors:
- **Direct** — child updates simultaneously with parent.
- **Delayed** — child lags by some ms; feels like a follow-through.
- **Inverse** — child moves opposite to parent (e.g. background recedes as foreground advances).

```ts
// Tab bar shifts in sympathy with hero collapse
$effect(() => {
  const compact = activeTab === 'members';
  animate(heroEl, { height: compact ? 120 : 288 }, { type: 'spring', stiffness: 180, damping: 19, mass: 1.3 });
  animate(tabsRowEl, { y: [compact ? -5 : 5, 0] }, { type: 'spring', stiffness: 220, damping: 15, mass: 0.9 });
});
```

### 4. Transformation — one object morphs into another
Submit button → spinner → checkmark. The shape, color, and content all flow through one continuous animation. Don't crossfade between two separate elements — keep one element, mutate it.

```ts
// Width / radius / background through a single spring
animate(btn, { width: 40, borderRadius: '50%', backgroundColor: '#22c55e' },
  { type: 'spring', stiffness: 320, damping: 24 });
```

### 5. Value Change — animate numeric values
Numeric labels should *count* to their new value, not snap. Activates "neurofeedback" — the user feels the system as alive and reactive.

```ts
animate(0, 1234, {
  type: 'spring', stiffness: 60, damping: 20,
  onUpdate: (v) => { label.textContent = Math.round(v).toLocaleString(); }
});
```

### 6. Masking — change utility by changing shape
A header image rounds and shrinks into a thumbnail; the content stays put inside. Animate the bounding box (border-radius, clip-path, width/height) — not the contents.

```ts
animate(headerImg, { borderRadius: '50%', width: 48, height: 48 },
  { type: 'spring', stiffness: 240, damping: 22 });
```

### 7. Overlay — z-axis ordering communicates spatial layers
A drawer slides over content, a sheet rises from the bottom. Always pair an `Overlay` motion with a backdrop dim or scale-down on the layer behind, so the user feels the depth. Use `Math.min` to ensure the new layer doesn't fully eclipse the old without an animated transition.

```ts
animate(behind, { scale: 0.96, opacity: 0.7 }, { type: 'spring', stiffness: 300, damping: 30 });
animate(sheet, { y: ['100%', '0%'] }, { type: 'spring', stiffness: 280, damping: 28, mass: 1 });
```

### 8. Cloning — origin and departure narrative
A new card shouldn't fade in. It should *come from somewhere*: from the button that created it, from the edge of the screen, from a duplicated source. Animate the origin position into the destination.

```ts
const fromRect = sourceBtn.getBoundingClientRect();
const toRect   = newCardEl.getBoundingClientRect();
animate(newCardEl,
  { x: [fromRect.x - toRect.x, 0], y: [fromRect.y - toRect.y, 0], scale: [0.4, 1], opacity: [0, 1] },
  { type: 'spring', stiffness: 320, damping: 26 });
```

### 9. Obscuration — backdrop blur + transparency for "behind"
Modal backgrounds, focus modes. Animate `filter: blur()` + `opacity` together; never one without the other. Static obscuration is just a state; the *act* of obscuring is what builds spatial awareness.

```ts
animate(behind, { filter: ['blur(0px)', 'blur(8px)'], opacity: [1, 0.6] },
  { type: 'spring', stiffness: 220, damping: 24 });
```

### 10. Parallax — different rates create depth
Background scrolls slower than foreground. Driven by scroll position, not time. Use a `useScroll` pattern or attach a scroll listener that maps scroll → child y via a spring (with low stiffness so the parallax lags slightly behind the scroll).

```ts
const onScroll = () => {
  const y = window.scrollY;
  animate(bg,    { y: y * 0.3 }, { type: 'spring', stiffness: 200, damping: 30 });
  animate(midBg, { y: y * 0.6 }, { type: 'spring', stiffness: 220, damping: 28 });
};
```

### 11. Dimensionality — origami / floating / object 3D
Set `transformStyle: preserve-3d` and `perspective` on the parent, then animate `rotateX`, `rotateY`. Cursor-tracking tilt is the cheap-but-effective application; full card flips and origami menus are the full version.

```ts
function cardTilt(opts = {}) {
  const max = opts.max ?? 5;
  return (el) => {
    el.style.transformStyle = 'preserve-3d';
    el.style.perspective = '900px';
    let rect = null;
    el.addEventListener('pointerenter', () => rect = el.getBoundingClientRect());
    el.addEventListener('pointermove', (e) => {
      if (!rect) return;
      const x = (e.clientX - rect.left) / rect.width  - 0.5;
      const y = (e.clientY - rect.top)  / rect.height - 0.5;
      animate(el, { rotateX: -y * max, rotateY: x * max },
        { type: 'spring', stiffness: 380, damping: 28, mass: 0.5 });
    });
    el.addEventListener('pointerleave', () => {
      animate(el, { rotateX: 0, rotateY: 0 }, { type: 'spring', stiffness: 250, damping: 32 });
      rect = null;
    });
  };
}
```

### 12. Dolly & Zoom — navigate scenes spatially
A new view *zooms in from inside* the previous one, or the camera *dollies forward*. Animate `scale` + `transform-origin` (set the origin to where the user clicked) + a fade. Pair with route transitions so the entire app feels like one continuous space.

```ts
// Detail view zooms out from the card the user clicked
detailView.style.transformOrigin = `${clickX}px ${clickY}px`;
animate(detailView, { scale: [0.4, 1], opacity: [0, 1] },
  { type: 'spring', stiffness: 260, damping: 26 });
```

## Reusable Motion attachments

These are the patterns we've battle-tested in this repo. Drop them in any new component.

### `springHover` — velocity-aware lift
```ts
function springHover(opts = {}) {
  const { rest = 0, lift = -4, stiffness = 380, damping = 22 } = opts;
  return (el) => {
    const enter   = () => animate(el, { y: lift },     { type: 'spring', stiffness,        damping });
    const leave   = () => animate(el, { y: rest },     { type: 'spring', stiffness: stiffness * 0.8, damping: damping + 4 });
    const press   = () => animate(el, { scale: 0.97 }, { type: 'spring', stiffness: 600, damping: 28 });
    const release = () => animate(el, { scale: 1 },    { type: 'spring', stiffness: 420, damping: 18 });
    el.addEventListener('mouseenter', enter);
    el.addEventListener('mouseleave', leave);
    el.addEventListener('pointerdown', press);
    el.addEventListener('pointerup', release);
    el.addEventListener('pointerleave', release);
    return () => { /* removeEventListener for all */ };
  };
}
```

### `springPop` — one-shot pop on activation
Fires when `active()` flips false → true. Doesn't replay if the value stays true.
```ts
function springPop(active) {
  return (el) => {
    let prev = active();
    $effect(() => {
      const next = active();
      if (next && !prev) {
        animate(el, { scale: [0.92, 1.04, 1] }, { type: 'spring', stiffness: 480, damping: 16, mass: 0.9 });
      }
      prev = next;
    });
  };
}
```

### `springWidth` — interpolate width between two pixel values
```ts
function springWidth(active, opts) {
  return (el) => {
    el.style.width = `${active() ? opts.on : opts.rest}px`;
    let prev = active();
    $effect(() => {
      const next = active();
      if (next === prev) return;
      prev = next;
      animate(el, { width: `${next ? opts.on : opts.rest}px` },
        { type: 'spring', stiffness: opts.stiffness ?? 380, damping: opts.damping ?? 22, mass: opts.mass ?? 0.7 });
    });
  };
}
```

### `motionPopover` — IN/OUT lifecycle with mid-flight reopen handling
Render with a separate "render" flag that lags behind "open" so the OUT spring can play before unmount. CSS `transform-origin` on the element controls *where* it springs from.
```ts
function motionPopover({ from = { y: -6, scale: 0.94, opacity: 0 }, stiffness = 520, damping = 30, mass = 0.85, closing, onClosed }) {
  return (el) => {
    animate(el, { opacity: [from.opacity, 1], scale: [from.scale, 1], y: [from.y, 0] },
      { type: 'spring', stiffness, damping, mass });
    let firstRun = true;
    $effect(() => {
      const isClosing = closing();
      if (firstRun) { firstRun = false; return; }
      if (isClosing) {
        animate(el, { opacity: from.opacity, scale: from.scale, y: from.y },
          { type: 'spring', stiffness: stiffness * 1.1, damping: damping + 6, mass })
          .finished.then(() => { if (closing()) onClosed(); });
      } else {
        animate(el, { opacity: 1, scale: 1, y: 0 }, { type: 'spring', stiffness, damping, mass });
      }
    });
  };
}
```
Usage:
```svelte
<script>
  let open = $state(false);
  let render = $state(false);
  $effect(() => { if (open) render = true; });
</script>

{#if render}
  <div {@attach motionPopover({
    closing: () => !open,
    onClosed: () => { render = false; }
  })}>...</div>
{/if}
```

### `portalUnder` — escape stacking contexts
When the parent has `backdrop-filter`, `transform`, or any other stacking-context creator, `z-index` won't push a popover above siblings outside that context. Move the element to `<body>` and pin it with `position: fixed`.
```ts
function portalUnder(getAnchor, offset = 6) {
  return (el) => {
    const place = () => {
      const a = getAnchor();
      if (!a) return;
      const r = a.getBoundingClientRect();
      Object.assign(el.style, {
        position: 'fixed',
        top: `${r.bottom + offset}px`,
        right: `${window.innerWidth - r.right}px`,
        left: 'auto',
        zIndex: '9999'
      });
    };
    place();
    document.body.appendChild(el);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      el.remove();
    };
  };
}
```

## Common pitfalls

- **CSS `animation`/`transition` on the same property Motion is animating.** Pick one. CSS will silently override or get overridden depending on browser version. If you adopt Motion for a property, delete the CSS for it.
- **`transform-origin` not set.** A spring that scales from `0.94 → 1` will look like it pops from the *center* unless you set `transform-origin` to where it should appear from (e.g. `top right` for a menu attached to a top-right pill).
- **Composing two springs writing the same component.** `animate(el, { y: -4 })` followed immediately by `animate(el, { y: 0 })` mid-motion is fine — Motion handles it with velocity preservation. But two `$effect`s racing to write `y` will fight. Single source of truth per transform axis.
- **Stale `bind:this` refs in `$effect`.** When a Svelte `{#if}` block re-mounts, the freshly bound element isn't available until after the next microtask. Wrap motion calls in `tick().then(...)` if you need the new element.
- **Animating layout properties in a hot loop.** `width`, `height`, `padding` cause reflow. Prefer `transform: scale()` for size-only changes; reserve real `width`/`height` springs for cases where layout flow must respond (e.g. a collapsing hero that pushes content up).
- **Forgetting `prefers-reduced-motion`.** Wrap any decorative motion in a check, or apply Motion's reduced-motion behavior. State-driven motion (popovers, transitions) should still play but with much shorter, near-critically-damped springs.
- **`backdrop-filter` traps stacking contexts.** If your popover is inside a `backdrop-filter` element and gets clipped/hidden behind siblings, use `portalUnder` (above).
- **Looping ambient animations** (status pulses, breathing icons) should stay in CSS `@keyframes`. Motion's runtime loop costs more for endlessly-running visuals; the browser compositor handles CSS keyframes more cheaply. Save Motion for state-driven animation.

## When redesigning a UI to be physics-based

Approach in this order:

1. **Catalogue the state changes.** List every place the UI transitions: tabs, modals, navigation, hover, drag, value updates. Each is a candidate for motion.
2. **Apply the four pillars.** For each transition, ask: does the user expect this? Does it preserve continuity? Does it tell a coherent narrative? Does it convey the right relationship between objects?
3. **Choose the principle, then the technique.** Don't start with "I'll add a fade." Start with "this transition needs to communicate hierarchy" → Parallax or Parenting → animate position of background slower than foreground.
4. **Animate transitions, not states.** Replace any `transition: ... 0.2s ease` with a Motion spring driven by the state change. Replace `display: none ↔ block` with a render flag pattern + popover springs.
5. **Tune by feeling, not numbers first.** Start from the cheatsheet, then nudge. The right values are the ones where you stop noticing the animation and just feel the response.
6. **Strip dead CSS.** Every animation moved to Motion means the CSS keyframes/transitions for those properties should be deleted. Two systems writing the same property will fight you forever.
7. **Test with `prefers-reduced-motion`.** Every motion you add should degrade gracefully.

## Files to study in this repo

- `frontend/src/routes/[orgSlug=orgSlug]/projects/[projectSlug]/+page.svelte` — full implementation: hero collapse, sympathetic shockwave, card stagger, hover lift, cursor tilt, dot pagination, popover lifecycle, portaling.
