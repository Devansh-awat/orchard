/**
 * Motion system.
 *
 * Modelled on Apple's motion design: a small set of named springs described by
 * perceptual duration and bounce (the SwiftUI `.smooth` / `.snappy` / `.bouncy`
 * vocabulary) rather than raw stiffness and damping, and three accessibility
 * tiers that every animation in the app resolves through.
 *
 *   full     the named spring, transforms allowed
 *   reduced  a 120ms crossfade, transforms stripped (what iOS Reduce Motion does)
 *   off      nothing moves, including ambient loops and gradients
 *
 * Built on `motion` (motion.dev).
 */
import { animate } from 'motion';
import { effectiveAnimationLevel } from '$lib/stores/preferences';

export type SpringName = 'smooth' | 'snappy' | 'bouncy' | 'interactive' | 'cinematic';

type Keyframes = Record<string, unknown>;
type Options = Record<string, unknown>;

/**
 * `visualDuration` is the time to first reach the target, which is how Apple's
 * `.spring(duration:bounce:)` reads, and `bounce` is the same 0..1 overshoot.
 *
 * Bounce is kept high and duration low. The bounce is what makes motion read as
 * alive — a zero-bounce spring asymptotes into place and feels sluggish however
 * short you make it — but the folder demo's 0.37s is sized for a full-screen
 * gesture. Application chrome opening a panel wants a fraction of that: enough
 * animation to see where things came from, not a performance.
 */
const SPRINGS: Record<SpringName, { visualDuration: number; bounce: number }> = {
	smooth: { visualDuration: 0.26, bounce: 0.2 },
	snappy: { visualDuration: 0.19, bounce: 0.25 },
	bouncy: { visualDuration: 0.28, bounce: 0.45 },
	interactive: { visualDuration: 0.1, bounce: 0.2 },
	// Full-viewport choreography, not chrome: the setup overture's closing move
	// travels half the screen while shrinking to a third, and it is seen once.
	// Measured off the build this was tuned on, that move ran about 0.75s to
	// settle; the four springs above are all sized for a panel and turn it into
	// a cut, which is what it had become. Low bounce because something this large overshooting reads as a
	// wobble rather than as life. Do not reach for this for UI chrome.
	cinematic: { visualDuration: 0.8, bounce: 0.14 }
};

/** Exits leave quicker and looser than entrances, the way the demo's do. */
const EXIT_SCALE = 0.8;
const EXIT_BOUNCE = 0.15;

/**
 * The decay curve for an event marker. Deliberately much longer than any of the
 * named springs because it is not a transition between two states — the state
 * has already arrived — it is the trail left behind so you can see what moved.
 */
const ECHO_DECAY = { type: 'spring', bounce: 0.2, duration: 0.8 };
const ECHO_DECAY_REDUCED = { duration: 0.4, ease: 'linear' };

/**
 * `reduced` is a cross-fade, not a fast-forward.
 *
 * Compressing the same choreography into a fraction of the time makes it worse
 * for the people who asked for less motion: a 500px panel closing in 120ms is a
 * snap, which is exactly the kind of abrupt change Reduce Motion exists to
 * avoid. So the tier keeps a calm, unhurried duration and drops the motion
 * instead — transforms are stripped by `adapt`, and opacity carries the change
 * on a gentle symmetric curve. Slower than `full`'s spring arrival, deliberately.
 */
const REDUCED_DURATION = 0.26;
const REDUCED_EASE = [0.33, 0, 0.2, 1];

/** The demo staggers at 25ms. Anything slower reads as a wave, not a group. */
const STAGGER_STRIDE = 0.025;

/** Items leave and arrive at 0.2 scale, measured off the demo. */
const BURST_SCALE = 0.2;

const MAX_STAGGER = 0.2;
/**
 * Zero. A stagger is choreography — the eye tracks a wave travelling across the
 * group — and that is motion even when nothing translates. Reduced fades the
 * whole group in together.
 */
const REDUCED_MAX_STAGGER = 0;

const DECORATIVE_KEYS = new Set([
	'x',
	'y',
	'z',
	'scale',
	'scaleX',
	'scaleY',
	'rotate',
	'rotateX',
	'rotateY',
	'rotateZ',
	'skewX',
	'skewY',
	'translateX',
	'translateY'
]);

export const motionLevel = () => effectiveAnimationLevel();
export const motionEnabled = () => effectiveAnimationLevel() !== 'off';
export const decorativeMotion = () => effectiveAnimationLevel() === 'full';
export const functionalMotion = () => effectiveAnimationLevel() !== 'off';

/**
 * Gate for a movingicons `animate` prop.
 *
 * Those icons animate with plain CSS inside the package, and their end state is
 * a static transform rather than a keyframe — so the tier rules in tokens.css
 * only shorten the transition, they don't stop the icon from snapping to its
 * animated pose. Icon hover flourishes are pure decoration, so the fix is to
 * never enter the animate state below `full`: wrap the hover flag in this.
 */
export const iconAnimation = (on: boolean) => on && decorativeMotion();

/**
 * Resolves a named spring against the current tier. Every animation in the app
 * goes through this so a tier change is one edit, not fifty.
 */
/**
 * Resolves a named spring against the current tier. Every animation in the app
 * goes through this so a tier change is one edit, not fifty.
 *
 * There is deliberately no "no overshoot" option. A value heading for a hard
 * floor wants `springToFloor`, not a bezier: every curve tried here front-loaded
 * so hard that the motion was two thirds done in the first 70ms and then crawled,
 * which reads as an instant snap.
 */
/**
 * A big panel needs longer than a small one, or it steps.
 *
 * Duration is a *rate* problem, not a taste problem: 812px collapsing in 190ms
 * moves 313px in a single frame, and the eye reads that as discrete jumps no
 * matter how good the curve is. Scaling sub-linearly with distance keeps short
 * moves snappy while giving long ones enough frames to look continuous — which
 * is also just how physical objects behave.
 */
const DISTANCE_REFERENCE = 260;
const DISTANCE_MAX_SCALE = 1.9;

function distanceScale(distance?: number): number {
	if (!distance || distance <= DISTANCE_REFERENCE) return 1;
	return Math.min(Math.sqrt(distance / DISTANCE_REFERENCE), DISTANCE_MAX_SCALE);
}

export function transition(
	name: SpringName = 'snappy',
	opts: { delay?: number; exit?: boolean; distance?: number } = {}
): Options {
	const level = effectiveAnimationLevel();
	if (level === 'off') return { duration: 0, delay: 0 };
	const delay = opts.delay ?? 0;
	if (level === 'reduced') {
		return {
			duration: REDUCED_DURATION,
			ease: REDUCED_EASE,
			delay: Math.min(delay, REDUCED_MAX_STAGGER)
		};
	}
	const spring = SPRINGS[name];
	const base = opts.exit ? spring.visualDuration * EXIT_SCALE : spring.visualDuration;
	const duration = base * distanceScale(opts.distance);
	return {
		type: 'spring',
		visualDuration: duration,
		bounce: opts.exit ? spring.bounce + EXIT_BOUNCE : spring.bounce,
		delay: Math.min(delay, MAX_STAGGER)
	};
}

/**
 * Strips movement and scaling below `full`, leaving opacity and functional
 * geometry (height, width, colour) to carry the change.
 */
export function adapt(keyframes: Keyframes): Keyframes {
	if (effectiveAnimationLevel() === 'full') return keyframes;
	const out: Keyframes = {};
	for (const key of Object.keys(keyframes)) {
		if (!DECORATIVE_KEYS.has(key)) out[key] = keyframes[key];
	}
	return out;
}

/**
 * Tier-aware `animate`. Returns null when the tier leaves nothing to animate,
 * so callers can fall back to setting the final state directly.
 */
export function motion(
	el: Element,
	keyframes: Keyframes,
	name: SpringName = 'snappy',
	opts: { delay?: number; exit?: boolean } = {}
) {
	if (!motionEnabled()) return null;
	const kf = adapt(keyframes);
	if (Object.keys(kf).length === 0) return null;
	return animate(el as HTMLElement, kf as never, transition(name, opts) as never);
}

/**
 * Springs a numeric style property down to a hard floor without the artefact
 * that makes a plain `animate(el, { height: 0 })` stutter.
 *
 * Height cannot go negative. A bouncy spring undershoots, the browser discards
 * every invalid write, and the box freezes at its last valid value before
 * snapping shut. Swapping in a bezier avoids that but loses the physics and
 * reads flat. Driving the spring ourselves and clamping each frame keeps real
 * spring dynamics: it arrives, sits closed through the invisible undershoot,
 * and settles — which is what Apple's disclosures actually do.
 */
export function springToFloor(
	el: HTMLElement,
	prop: 'height' | 'width',
	from: number,
	opts: { name?: SpringName; exit?: boolean; delay?: number; onFloor?: () => void } = {}
) {
	if (!motionEnabled()) {
		el.style[prop] = '0px';
		opts.onFloor?.();
		return null;
	}
	let reached = false;
	return animate(from, 0, {
		...(transition(opts.name ?? 'smooth', {
			exit: opts.exit,
			delay: opts.delay,
			distance: from
		}) as object),
		onUpdate: (v: number) => {
			const clamped = Math.max(0, v);
			el.style[prop] = `${clamped}px`;
			if (!reached && clamped <= 0.5) {
				reached = true;
				opts.onFloor?.();
			}
		}
	});
}

export function staggerDelay(index: number, stride = STAGGER_STRIDE): number {
	return Math.min(index * stride, MAX_STAGGER);
}

/**
 * Survives attachment re-creation, which would otherwise re-capture the new
 * value as the previous one and swallow every change.
 */
/** Entrance plays once per element, so a re-created attachment does not replay
 * the fade-in on live DOM. */
const staggeredEls = new WeakSet<Element>();

const HOVER_LIFT = -2;
const PRESS_SCALE = 0.97;

const echoSeen = new WeakMap<Element, unknown>();

/** Survives attachment re-creation, same reason as the others. */
const overlayOpen = new WeakMap<Element, boolean>();
const panelActive = new WeakMap<Element, boolean>();

/** Entry vectors and entry-played flags, so a re-created attachment neither
 * replays the entrance nor re-measures against a container that is mid-collapse. */
const burstVectors = new WeakMap<Element, Point>();
const burstEntered = new WeakSet<Element>();

/** Same reason as `echoSeen`: the attachment is re-created when a sibling
 * attribute changes, and a closure-local flag would re-capture the current
 * value as the previous one and never see the open/close transition. */
const burstClosing = new WeakMap<Element, boolean>();

/**
 * The whole group is choreographed inside this window however many items there
 * are. Per-item stride is what reads as a top-to-bottom wave: two tiles 25ms
 * apart look simultaneous, eleven at 25ms apart is a half-second sweep down the
 * page. Holding the total fixed keeps every group feeling like one gesture,
 * which is the difference between the two-tile case looking right and the
 * ten-tile case looking like a slow scan down the page.
 */
const BURST_WINDOW = 0.06;

/** How far back toward the origin a tile pulls on close, and how far it shrinks. */
const EXIT_DRIFT = 0.4;
const EXIT_SCALE_TO = 0.8;

/**
 * The launch point has to sit inside whatever clips the content, or the most
 * expressive part of the flight happens where nothing can be seen.
 *
 * On the dashboard the origin is the project avatar, which lives in the header
 * *above* a body with `overflow: hidden`. Launching from the avatar put every
 * tile outside the clip, so they were invisible until they had already fallen
 * most of the way, and then appeared to snap into place. Clamping the origin
 * into the content box keeps the "out from under the header" read and stays
 * visible the whole way.
 */
function clampIntoContent(origin: Point, content: Element | null): Point {
	if (!content) return origin;
	const b = content.getBoundingClientRect();
	if (b.width === 0 && b.height === 0) return origin;
	return {
		x: Math.min(Math.max(origin.x, b.left), b.right),
		y: Math.min(Math.max(origin.y, b.top), b.bottom)
	};
}

/**
 * Marks that a value describing real cluster state has changed.
 *
 * Orchard's state mostly is not typed in by the user — it arrives from SSE and
 * the pod informer, describing something that already happened on the cluster.
 * Animating *into* such a state adds latency to information: a pod that died
 * 200ms ago should not spend another 350ms springing a red dot into view. So
 * the new state is already on screen by the time this runs, and all it does is
 * drive `--echo` from 1 to 0 so the element can paint a trail showing which row
 * just moved. That trail is what tells you what changed while you were on
 * another tab.
 *
 * Never fires on mount: a freshly rendered list has not "just changed".
 * Survives `reduced` as a plain fade, because it carries information and moves
 * nothing. Silent at `off`.
 */
export function stateEcho(key: () => unknown) {
	return (el: Element) => {
		const target = el as HTMLElement;
		const ring = document.createElement('span');
		ring.className = 'motion-echo-ring';
		ring.setAttribute('aria-hidden', 'true');
		target.appendChild(ring);
		let running: { stop: () => void } | null = null;
		$effect(() => {
			const next = key();
			const seen = echoSeen.has(target);
			const prev = echoSeen.get(target);
			echoSeen.set(target, next);
			if (!seen || Object.is(next, prev)) return;
			if (!motionEnabled()) return;
			running?.stop();
			target.style.setProperty('--echo', '1');
			running = animate(
				target,
				{ '--echo': 0 } as never,
				(decorativeMotion() ? ECHO_DECAY : ECHO_DECAY_REDUCED) as never
			);
		});
		return () => {
			running?.stop();
			ring.remove();
		};
	};
}

export interface Point {
	x: number;
	y: number;
}

export function centerOf(el: Element): Point {
	const r = el.getBoundingClientRect();
	return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/**
 * Launches an element out of a measured page-space point and puts it back there
 * on close, the way an iOS folder throws its apps outward.
 *
 * The origin is a real point, not a generic offset, so every item gets its own
 * vector and the group reads as having come from somewhere. Opacity lags the
 * movement by 50ms on the way out, which is what stops it reading as a fade:
 * the item is still visible while it travels back home.
 *
 * The stagger stride shrinks as the group grows so the whole fan is always
 * choreographed inside `BURST_WINDOW`. A fixed per-item stride is what turns a
 * ten-item group into a slow top-to-bottom wave.
 *
 * Opens on `snappy`, matching the close. On `smooth` the last tile of a six-tile
 * project was only readable 300ms after the click, which read as the card
 * hesitating rather than opening.
 */
export function originBurst(opts: {
	origin: () => Point | null;
	index?: number;
	count?: number;
	closing?: () => boolean;
	onClosed?: () => void;
	scale?: number;
}) {
	const index = opts.index ?? 0;
	const count = opts.count ?? 1;
	const collapsed = opts.scale ?? BURST_SCALE;
	const stride = count > 1 ? Math.min(STAGGER_STRIDE, BURST_WINDOW / (count - 1)) : STAGGER_STRIDE;
	return (el: Element) => {
		const target = el as HTMLElement;

		// Measured on the way out, then reused for the return trip: the
		// container's padding and height are animating during a close, so
		// re-measuring then would aim at a moving target. Resolved lazily
		// because the origin element's binding may not be set on first attach.
		const resolveLaunch = (): Point | null => {
			const cached = burstVectors.get(target);
			if (cached) return cached;
			const raw = opts.origin();
			if (!raw) return null;
			const o = clampIntoContent(raw, target.parentElement);
			const c = centerOf(target);
			const v = { x: o.x - c.x, y: o.y - c.y };
			burstVectors.set(target, v);
			return v;
		};

		const settle = () => {
			target.classList.remove('motion-entering');
			target.style.opacity = '';
			target.style.transform = '';
		};

		const entryLaunch = resolveLaunch();
		if (!burstEntered.has(target)) {
			burstEntered.add(target);
			if (motionEnabled() && entryLaunch) {
				// Same one-frame guard as the other entrances: without it the tile
				// paints at full opacity before the animation's first sample. At
				// `reduced`, where opacity is the only thing carrying the change,
				// that flash is the whole animation happening backwards first.
				target.classList.add('motion-entering');
				if (decorativeMotion()) {
					target.style.transform = `translate(${entryLaunch.x}px, ${entryLaunch.y}px) scale(${collapsed})`;
				}
				motion(
					target,
					{
						opacity: [0, 1],
						x: [entryLaunch.x, 0],
						y: [entryLaunch.y, 0],
						scale: [collapsed, 1]
					},
					'snappy',
					{ delay: index * stride }
				)?.finished.then(() => target.classList.remove('motion-entering'));
			} else {
				target.classList.remove('motion-entering');
				settle();
			}
		}

		if (!burstClosing.has(target)) burstClosing.set(target, opts.closing?.() ?? false);
		$effect(() => {
			const closing = opts.closing?.() ?? false;
			if (closing === burstClosing.get(target)) return;
			burstClosing.set(target, closing);

			const launch = resolveLaunch();
			if (!motionEnabled() || !launch) {
				settle();
				if (closing && index === 0) opts.onClosed?.();
				return;
			}

			// Reopened mid-flight. The element never unmounted, so nothing else
			// would ever bring it back from collapsed-and-invisible.
			if (!closing) {
				motion(target, { opacity: 1, x: 0, y: 0, scale: 1 }, 'snappy', {
					delay: index * stride
				});
				return;
			}

			// No stagger on the way out, unlike the entrance. The container clips
			// what it shrinks past, so the exit cannot show a real convergence —
			// only a short pull toward the origin. Staggering that tiny movement
			// does not read as choreography, it reads as eleven different opacities
			// at once, a gradient wiping across the grid. Leaving as one group is
			// what makes the card look like it took its contents with it.
			const delay = 0;
			// Not exit-scaled: the tiles should still be leaving while the container
			// is closing around them, so the card looks like it took its contents
			// with it rather than emptying first and then collapsing.
			motion(
				target,
				{ x: launch.x * EXIT_DRIFT, y: launch.y * EXIT_DRIFT, scale: EXIT_SCALE_TO },
				'snappy',
				{ delay }
			);
			const fade = animate(target, { opacity: 0 }, transition('snappy', { delay }) as never);
			if (index === 0) {
				fade.finished.then(() => {
					if (opts.closing?.()) opts.onClosed?.();
				});
			}
		});
	};
}

/**
 * Hover lift plus press feedback. Decorative, so it only runs at `full`; at
 * lower tiers the CSS colour transition on the element carries the hover state.
 */
export function springHover(
	opts: { rest?: number; lift?: number; forwardIconHover?: boolean } = {}
) {
	const rest = opts.rest ?? 0;
	const lift = opts.lift ?? HOVER_LIFT;
	return (el: Element) => {
		const target = el as HTMLElement;
		let pressed = false;
		const enter = () => {
			if (opts.forwardIconHover && decorativeMotion()) {
				target.querySelectorAll('[role="img"]').forEach((icon) => {
					icon.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
				});
			}
			if (!decorativeMotion() || lift === 0) return;
			animate(target, { y: lift }, transition('snappy') as never);
		};
		const settle = () => {
			if (!decorativeMotion()) return;
			animate(target, { y: rest, scale: 1 }, transition('snappy') as never);
		};
		const leave = () => {
			pressed = false;
			settle();
		};
		const press = () => {
			if (!decorativeMotion()) return;
			pressed = true;
			animate(target, { scale: PRESS_SCALE }, transition('interactive') as never);
		};
		const release = () => {
			if (!pressed) return;
			pressed = false;
			if (!decorativeMotion()) return;
			animate(target, { scale: 1 }, transition('snappy') as never);
		};
		target.addEventListener('mouseenter', enter);
		target.addEventListener('mouseleave', leave);
		target.addEventListener('pointerdown', press);
		target.addEventListener('pointerup', release);
		target.addEventListener('pointercancel', release);
		return () => {
			target.removeEventListener('mouseenter', enter);
			target.removeEventListener('mouseleave', leave);
			target.removeEventListener('pointerdown', press);
			target.removeEventListener('pointerup', release);
			target.removeEventListener('pointercancel', release);
		};
	};
}

export function motionStagger(
	opts: { index?: number; stride?: number; from?: { y?: number; opacity?: number } } = {}
) {
	const i = opts.index ?? 0;
	const stride = opts.stride ?? STAGGER_STRIDE;
	const from = { y: opts.from?.y ?? 8, opacity: opts.from?.opacity ?? 0 };
	return (el: Element) => {
		// Entrance plays once per element — a re-run of the attachment (index
		// shift, list reorder) must not replay the fade-in on live DOM.
		if (staggeredEls.has(el)) return;
		staggeredEls.add(el);
		if (!motionEnabled()) return;
		// Hidden until the animation owns opacity. Between mount and the first
		// sample the element would otherwise paint at full opacity, which reads as
		// a flash before the entrance — most visible on a staggered item whose
		// delay pushes that first sample several frames out.
		const target = el as HTMLElement;
		target.classList.add('motion-entering');
		motion(el, { opacity: [from.opacity, 1], y: [from.y, 0] }, 'smooth', {
			delay: i * stride
		})?.finished.then(() => target.classList.remove('motion-entering'));
	};
}

/**
 * The one motion path for every transient surface: menus, popovers, dropdowns.
 *
 * Two things it fixes over the CSS keyframe it replaces. There is now an exit —
 * a surface that vanishes because a rule flipped to `display: none` has no
 * opposing force and reads as a glitch, not a dismissal. And it is interruptible:
 * on re-open mid-dismiss the element already carries live transform values, so
 * only the targets are given and Motion continues from wherever it actually is,
 * per WWDC18's rule to animate from the presentation value rather than a fixed
 * start. Seeding the closed state only when nothing is running is what keeps a
 * fresh open crisp without snapping an interrupted one backwards.
 */
/**
 * Entrance for a tab panel that stays mounted and is revealed by a flag.
 *
 * Replaces a bespoke 320ms CSS keyframe whose `cubic-bezier(0.22, 1, 0.36, 1)`
 * was 91% complete in the first 136ms and then crawled: nominally slow, visually
 * instant, nothing to appreciate. A spring spends its time where the eye can see
 * it and arrives decisively, which is the whole difference.
 */
export function motionPanel(isActive: () => boolean) {
	return (el: Element) => {
		const target = el as HTMLElement;
		if (!panelActive.has(target)) panelActive.set(target, isActive());
		$effect(() => {
			const active = isActive();
			if (active === panelActive.get(target)) return;
			panelActive.set(target, active);
			if (!active || !motionEnabled()) return;
			// Hidden for the frame between the panel being revealed and the
			// animation's first sample, otherwise it paints once at full opacity
			// and then jumps back to the start.
			target.classList.add('motion-entering');
			motion(target, { opacity: [0, 1], y: [14, 0] }, 'smooth')?.finished.then(() =>
				target.classList.remove('motion-entering')
			);
		});
	};
}

export function overlayMotion(isOpen: () => boolean, opts: { origin?: string } = {}) {
	const from = { opacity: 0, scale: 0.96, y: -6 };
	return (el: Element) => {
		const target = el as HTMLElement;
		if (opts.origin) target.style.transformOrigin = opts.origin;

		// A class, not inline styles: the popover library rewrites this element's
		// `style` attribute while positioning it, so an inline seed is gone by the
		// next frame and the panel paints at full opacity for one frame first.
		const seedClosed = () => target.classList.add('motion-entering');

		if (!overlayOpen.has(target)) overlayOpen.set(target, isOpen());
		$effect(() => {
			const open = isOpen();
			if (open === overlayOpen.get(target)) return;
			overlayOpen.set(target, open);

			if (!motionEnabled()) {
				target.classList.remove('motion-entering');
				target.style.opacity = '';
				target.style.transform = '';
				target.style.display = '';
				return;
			}

			if (open) {
				// These are native popovers, so the element is not in the top layer
				// until the library calls showPopover(), which happens after this
				// effect. Animating a frame early runs against a non-rendered element
				// and completes instantly, which is why the open used to just appear.
				// Seeded now, animated next frame. Deferring the seed too would let the
				// panel paint at full opacity for one frame before snapping back to
				// start, which reads as a flash.
				const fresh = target.getAnimations().length === 0;
				if (fresh) seedClosed();
				requestAnimationFrame(() => {
					if (!isOpen()) {
						target.classList.remove('motion-entering');
						return;
					}
					// A fresh open declares its own start, because the popover library
					// rewrites this element's `style` attribute while positioning and
					// wipes any seeded inline values. An interrupted one passes targets
					// only, so the spring continues from the live on-screen values
					// instead of snapping back to the start.
					motion(
						target,
						fresh
							? { opacity: [from.opacity, 1], scale: [from.scale, 1], y: [from.y, 0] }
							: { opacity: 1, scale: 1, y: 0 },
						'snappy'
					)?.finished.then(() => target.classList.remove('motion-entering'));
				});
				return;
			}

			// The entering class outranks nothing once the animation is gone, so it
			// has to come off before the exit reads the element's current opacity.
			target.classList.remove('motion-entering');
			// Outlive the `display: none` that CSS applies once the panel closes,
			// otherwise there is nothing left on screen to animate.
			target.style.display = 'block';
			// Not exit-scaled: a menu that is already only 250ms reads as a blink if
			// it is shortened further, and the dismissal is the half that has to be
			// legible for the panel to feel like it went somewhere.
			const exit = motion(
				target,
				{ opacity: from.opacity, scale: from.scale, y: from.y },
				'snappy'
			);
			if (!exit) {
				target.style.display = '';
				return;
			}
			exit.finished.then(() => {
				if (isOpen()) return;
				target.style.display = '';
				target.style.opacity = '';
				target.style.transform = '';
			});
		});
	};
}

export function motionPopover(opts: {
	from?: { opacity?: number; scale?: number; y?: number };
	closing: () => boolean;
	onClosed: () => void;
}) {
	const from = {
		opacity: opts.from?.opacity ?? 0,
		scale: opts.from?.scale ?? 0.94,
		y: opts.from?.y ?? -4
	};
	return (el: Element) => {
		const target = el as HTMLElement;
		motion(
			target,
			{ opacity: [from.opacity, 1], scale: [from.scale, 1], y: [from.y, 0] },
			'snappy'
		);
		let firstRun = true;
		$effect(() => {
			const closing = opts.closing();
			if (firstRun) {
				firstRun = false;
				return;
			}
			if (!motionEnabled()) {
				if (closing) opts.onClosed();
				return;
			}
			if (closing) {
				const exit = motion(
					target,
					{ opacity: from.opacity, scale: from.scale, y: from.y },
					'snappy',
					{ exit: true }
				);
				exit?.finished.then(() => {
					if (opts.closing()) opts.onClosed();
				});
			} else {
				motion(target, { opacity: 1, scale: 1, y: 0 }, 'snappy');
			}
		});
	};
}

export function motionBackdrop(closing: () => boolean, onClosed: () => void) {
	return (el: Element) => {
		const target = el as HTMLElement;
		if (motionEnabled()) {
			animate(target, { opacity: [0, 1] }, transition('smooth') as never);
		}
		let firstRun = true;
		$effect(() => {
			const c = closing();
			if (firstRun) {
				firstRun = false;
				return;
			}
			if (!c) return;
			if (!motionEnabled()) {
				onClosed();
				return;
			}
			animate(target, { opacity: 0 }, transition('snappy', { exit: true }) as never).finished.then(
				() => {
					if (closing()) onClosed();
				}
			);
		});
	};
}

/**
 * Height collapse. Functional rather than decorative, so it still animates at
 * `reduced`, just as a quick fade-and-resize instead of a spring.
 */
export function springCollapse(collapsed: () => boolean) {
	return (el: Element) => {
		const target = el as HTMLElement;
		target.style.overflow = 'hidden';
		const naturalMargin = parseFloat(getComputedStyle(target).marginTop) || 0;
		const naturalHeight = () => {
			const prev = target.style.height;
			target.style.height = 'auto';
			const h = target.scrollHeight;
			target.style.height = prev;
			return h;
		};
		let last: boolean | null = null;
		let heightAnim: { stop: () => void; finished: Promise<unknown> } | null = null;
		$effect(() => {
			const isCollapsed = collapsed();
			if (last === null) {
				last = isCollapsed;
				if (isCollapsed) {
					target.style.height = '0px';
					target.style.opacity = '0';
					target.style.marginTop = '0px';
				}
				return;
			}
			if (isCollapsed === last) return;
			last = isCollapsed;
			target.style.marginTop = isCollapsed ? '0px' : `${naturalMargin}px`;
			if (!motionEnabled()) {
				target.style.height = isCollapsed ? '0px' : 'auto';
				target.style.opacity = isCollapsed ? '0' : '1';
				if (!isCollapsed) target.style.marginTop = '';
				return;
			}
			// Height is driven as a plain value and written straight to the style,
			// never handed to Motion as an element property. Motion retains
			// ownership of anything it has animated on an element and re-applies its
			// last value when the next animation starts there — so an element whose
			// expand animated `height` would have that height restored the moment
			// the collapse's opacity animation began, snapping the panel back open a
			// beat after it had closed. Clamping at zero keeps the spring's physics
			// without the negative-height stall.
			heightAnim?.stop();
			const fromH = target.getBoundingClientRect().height;
			const toH = isCollapsed ? 0 : naturalHeight();
			animate(target, { opacity: isCollapsed ? 0 : 1 }, transition('smooth') as never);
			heightAnim = animate(fromH, toH, {
				...(transition('smooth') as object),
				onUpdate: (v: number) => {
					target.style.height = `${Math.max(0, v)}px`;
				}
			});
			heightAnim.finished.then(() => {
				if (!collapsed()) {
					target.style.height = 'auto';
					target.style.marginTop = '';
				}
			});
		});
	};
}

/**
 * Rotation between two angles for disclosure indicators. The rotation *is* the
 * state, so it survives `reduced` as a quick tween.
 */
export function springRotate(active: () => boolean, opts: { rest?: number; on?: number } = {}) {
	const rest = opts.rest ?? 0;
	const on = opts.on ?? 180;
	return (el: Element) => {
		const target = el as HTMLElement;
		target.style.rotate = `${active() ? on : rest}deg`;
		let prev = active();
		$effect(() => {
			const next = active();
			if (next === prev) return;
			prev = next;
			if (!motionEnabled()) {
				target.style.rotate = `${next ? on : rest}deg`;
				return;
			}
			animate(target, { rotate: next ? on : rest }, transition('snappy') as never);
		});
	};
}

export function springScaleX(
	active: () => boolean,
	opts: { rest?: number; on?: number; name?: SpringName } = {}
) {
	const rest = opts.rest ?? 0;
	const on = opts.on ?? 1;
	// `smooth` rather than the `snappy` the body and tiles use: landing together
	// with them hides the draw inside the same beat, and the rule reads as having
	// appeared rather than been drawn. A little longer is what makes it visible.
	const name = opts.name ?? 'smooth';
	// Progress lives out here, in the factory closure, rather than per element.
	// Svelte re-creates the element this is attached to when the surrounding
	// markup re-renders, and a per-element value would restart each fresh node at
	// the resting value for the state it is being created into, which is the
	// finished position: the line would blink rather than draw.
	let current = active() ? on : rest;
	let prev = active();
	let running: { stop: () => void } | null = null;
	return (el: Element) => {
		const target = el as HTMLElement;
		const write = (v: number) => {
			// The spring undershoots past the floor on the way closed, and a
			// negative scale is a mirrored line rather than a shorter one.
			current = v < 0 ? 0 : v;
			target.style.transform = `scaleX(${current})`;
		};
		write(current);
		$effect(() => {
			const next = active();
			if (next === prev) return;
			prev = next;
			running?.stop();
			running = null;
			const to = next ? on : rest;
			if (!motionEnabled()) {
				write(to);
				return;
			}
			running = animate(current, to, {
				...(transition(name) as object),
				onUpdate: write
			} as never) as unknown as { stop: () => void };
		});
	};
}

export function springWidth(active: () => boolean, opts: { rest: number; on: number }) {
	return (el: Element) => {
		const target = el as HTMLElement;
		target.style.width = `${active() ? opts.on : opts.rest}px`;
		let prev = active();
		$effect(() => {
			const next = active();
			if (next === prev) return;
			prev = next;
			if (!motionEnabled()) {
				target.style.width = `${next ? opts.on : opts.rest}px`;
				return;
			}
			animate(target, { width: `${next ? opts.on : opts.rest}px` }, transition('smooth') as never);
		});
	};
}

export function springPop(active: () => boolean) {
	return (el: Element) => {
		const target = el as HTMLElement;
		let prev = active();
		$effect(() => {
			const next = active();
			if (next && !prev && decorativeMotion()) {
				animate(target, { scale: [0.94, 1] }, transition('bouncy') as never);
			}
			prev = next;
		});
	};
}

/**
 * Delegated hover/press for containers with many interactive children, so we
 * don't need an attachment per button.
 */
export function pressSpringDelegate(root: HTMLElement, selector: string) {
	let hovered: HTMLElement | null = null;
	const resolve = (e: PointerEvent) =>
		((e.target as HTMLElement | null)?.closest?.(selector) as HTMLElement | null) ?? null;
	const onMove = (e: PointerEvent) => {
		if (!decorativeMotion()) return;
		const t = resolve(e);
		if (t === hovered) return;
		if (hovered && !t?.contains(hovered) && !hovered.contains(t as Node)) {
			animate(hovered, { y: 0, scale: 1 }, transition('snappy') as never);
		}
		if (t && root.contains(t)) {
			animate(t, { y: HOVER_LIFT, scale: 1 }, transition('snappy') as never);
		}
		hovered = t;
	};
	const onLeaveRoot = () => {
		if (!hovered) return;
		animate(hovered, { y: 0, scale: 1 }, transition('snappy') as never);
		hovered = null;
	};
	const onDown = (e: PointerEvent) => {
		if (!decorativeMotion()) return;
		const t = resolve(e);
		if (!t || !root.contains(t)) return;
		animate(t, { scale: PRESS_SCALE, y: HOVER_LIFT }, transition('interactive') as never);
	};
	const onUp = (e: PointerEvent) => {
		if (!decorativeMotion()) return;
		const t = resolve(e);
		if (!t || !root.contains(t)) return;
		animate(t, { scale: 1, y: t === hovered ? HOVER_LIFT : 0 }, transition('snappy') as never);
	};
	root.addEventListener('pointermove', onMove, { passive: true });
	root.addEventListener('pointerleave', onLeaveRoot);
	root.addEventListener('pointerdown', onDown);
	root.addEventListener('pointerup', onUp);
	root.addEventListener('pointercancel', onUp);
	return () => {
		root.removeEventListener('pointermove', onMove);
		root.removeEventListener('pointerleave', onLeaveRoot);
		root.removeEventListener('pointerdown', onDown);
		root.removeEventListener('pointerup', onUp);
		root.removeEventListener('pointercancel', onUp);
	};
}

/**
 * A single highlight element that springs between targets, the way the iOS
 * pointer snaps from control to control, instead of every item cross-fading its
 * own background. Call from an attachment on the highlight element.
 */
export function magneticHighlight(target: () => HTMLElement | null | undefined) {
	return (el: Element) => {
		const pill = el as HTMLElement;
		pill.style.position = 'absolute';
		pill.style.left = '0';
		pill.style.top = '0';
		let placed = false;
		$effect(() => {
			const to = target();
			if (!to) {
				pill.style.opacity = '0';
				placed = false;
				return;
			}
			const parent = pill.offsetParent as HTMLElement | null;
			if (!parent) return;
			const a = to.getBoundingClientRect();
			const b = parent.getBoundingClientRect();
			const next = {
				x: a.left - b.left,
				y: a.top - b.top,
				width: `${a.width}px`,
				height: `${a.height}px`,
				opacity: 1
			};
			if (!placed || !motionEnabled()) {
				placed = true;
				pill.style.transform = `translate(${next.x}px, ${next.y}px)`;
				pill.style.width = next.width;
				pill.style.height = next.height;
				pill.style.opacity = '1';
				return;
			}
			animate(pill, next as never, transition('snappy') as never);
		});
	};
}
