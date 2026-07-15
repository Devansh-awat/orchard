/**
 * Shared motion/animation utilities — spring-based hover, press, stagger,
 * popover, backdrop, card-tilt, scroll-rubber, and delegated press-spring.
 *
 * Built on top of the `motion` library (Framer Motion equivalent).
 */
import { animate } from 'motion';
import { browser } from '$app/environment';
import { effectiveAnimationLevel } from '$lib/stores/preferences';

export const decorativeMotion = () => effectiveAnimationLevel() === 'full';
export const functionalMotion = () => effectiveAnimationLevel() !== 'off';

// ---- Pointer "hardness" tracker -------------------------------------------------
// Tracks pointer velocity in real time. On press, callers read `pointerHardness()`
// — a 0..1 value derived from velocity (mouse) or pressure (touch/stylus). Used to
// modulate spring response: harder push → deeper compress + livelier release.
let lastPointerX = 0;
let lastPointerY = 0;
let lastPointerT = 0;
let lastPointerSpeed = 0;
let lastPointerPressure = 0;

if (browser) {
	const onPointerMove = (e: PointerEvent) => {
		const now = performance.now();
		const dt = Math.max(1, now - lastPointerT);
		const dx = e.clientX - lastPointerX;
		const dy = e.clientY - lastPointerY;
		const speed = Math.sqrt(dx * dx + dy * dy) / dt; // px/ms
		lastPointerSpeed = lastPointerSpeed * 0.6 + speed * 0.4;
		lastPointerX = e.clientX;
		lastPointerY = e.clientY;
		lastPointerT = now;
		if (e.pressure && e.pressure > 0 && e.pointerType !== 'mouse') {
			lastPointerPressure = e.pressure;
		}
	};
	window.addEventListener('pointermove', onPointerMove, { passive: true });
}

export function pointerHardness(e?: PointerEvent): number {
	if (e && e.pressure && e.pressure > 0 && e.pointerType !== 'mouse') return e.pressure;
	if (lastPointerPressure > 0) return lastPointerPressure;
	// Map mouse speed (px/ms) to a 0..1 hardness; ~2 px/ms ≈ a firm flick.
	return Math.max(0, Math.min(1, lastPointerSpeed / 2));
}

export function getLastPointerSpeed(): number {
	return lastPointerSpeed;
}

// ---- Motion attachments -----------------------------------------------------------

const staggeredEls = new WeakSet<Element>();

export function springHover(
	opts: {
		rest?: number;
		lift?: number;
		stiffness?: number;
		damping?: number;
		forwardIconHover?: boolean;
	} = {}
) {
	const rest = opts.rest ?? 0;
	const lift = opts.lift ?? -3;
	const stiffness = opts.stiffness ?? 380;
	const damping = opts.damping ?? 22;
	return (el: Element) => {
		const target = el as HTMLElement;
		const enter = () => {
			if (opts.forwardIconHover) {
				target.querySelectorAll('[role="img"]').forEach((icon) => {
					icon.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
				});
			}
			if (!decorativeMotion()) return;
			animate(target, { y: lift }, { type: 'spring', stiffness, damping });
		};
		const leave = () => {
			if (!decorativeMotion()) return;
			animate(
				target,
				{ y: rest, scale: 1 },
				{ type: 'spring', stiffness: stiffness * 0.8, damping: damping + 4 }
			);
		};
		const press = (e: Event) => {
			if (!decorativeMotion()) return;
			const h = pointerHardness(e as PointerEvent);
			// 0.97 (soft tap) → 0.92 (hard slam). Higher stiffness on harder press.
			const compress = 0.97 - h * 0.05;
			const k = 520 + h * 260;
			animate(target, { scale: compress }, { type: 'spring', stiffness: k, damping: 26 });
		};
		const release = () => {
			if (!decorativeMotion()) return;
			const h = lastPointerSpeed / 2;
			const overshoot = 1 + Math.max(0, Math.min(1, h)) * 0.025;
			animate(
				target,
				{ scale: [null, overshoot, 1] as any },
				{ type: 'spring', stiffness: 420, damping: 14, mass: 0.7 }
			);
		};
		target.addEventListener('mouseenter', enter);
		target.addEventListener('mouseleave', leave);
		target.addEventListener('pointerdown', press);
		target.addEventListener('pointerup', release);
		target.addEventListener('pointerleave', release);
		return () => {
			target.removeEventListener('mouseenter', enter);
			target.removeEventListener('mouseleave', leave);
			target.removeEventListener('pointerdown', press);
			target.removeEventListener('pointerup', release);
			target.removeEventListener('pointerleave', release);
		};
	};
}

export function motionStagger(
	opts: {
		index?: number;
		stride?: number;
		from?: { y?: number; opacity?: number; scale?: number };
		stiffness?: number;
		damping?: number;
		mass?: number;
	} = {}
) {
	const i = opts.index ?? 0;
	const stride = opts.stride ?? 0.04;
	const from = {
		y: opts.from?.y ?? 8,
		opacity: opts.from?.opacity ?? 0,
		scale: opts.from?.scale ?? 0.99
	};
	return (el: Element) => {
		// Entrance plays once per element — a re-run of the attachment (index
		// shift, list reorder) must not replay the fade-in on live DOM.
		if (staggeredEls.has(el)) return;
		staggeredEls.add(el);
		if (!decorativeMotion()) return;
		animate(
			el as HTMLElement,
			{ opacity: [from.opacity, 1], y: [from.y, 0], scale: [from.scale, 1] },
			{
				type: 'spring',
				stiffness: opts.stiffness ?? 280,
				damping: opts.damping ?? 24,
				mass: opts.mass ?? 0.85,
				delay: i * stride
			}
		);
	};
}

export function motionPopover(opts: {
	from?: { opacity?: number; scale?: number; y?: number };
	stiffness?: number;
	damping?: number;
	mass?: number;
	closing: () => boolean;
	onClosed: () => void;
}) {
	const from = {
		opacity: opts.from?.opacity ?? 0,
		scale: opts.from?.scale ?? 0.94,
		y: opts.from?.y ?? -4
	};
	const stiffness = opts.stiffness ?? 520;
	const damping = opts.damping ?? 30;
	const mass = opts.mass ?? 0.85;
	return (el: Element) => {
		const target = el as HTMLElement;
		if (functionalMotion()) {
			animate(
				target,
				{ opacity: [from.opacity, 1], scale: [from.scale, 1], y: [from.y, 0] },
				{ type: 'spring', stiffness, damping, mass }
			);
		}
		let firstRun = true;
		$effect(() => {
			const closing = opts.closing();
			if (firstRun) {
				firstRun = false;
				return;
			}
			if (!functionalMotion()) {
				if (closing) opts.onClosed();
				return;
			}
			if (closing) {
				animate(
					target,
					{ opacity: from.opacity, scale: from.scale, y: from.y },
					{ type: 'spring', stiffness: stiffness * 1.1, damping: damping + 6, mass }
				).finished.then(() => {
					if (opts.closing()) opts.onClosed();
				});
			} else {
				animate(
					target,
					{ opacity: 1, scale: 1, y: 0 },
					{ type: 'spring', stiffness, damping, mass }
				);
			}
		});
	};
}

// Backdrop fade — pairs with motionPopover for modals.
export function motionBackdrop(closing: () => boolean, onClosed: () => void) {
	return (el: Element) => {
		const target = el as HTMLElement;
		if (functionalMotion()) {
			animate(target, { opacity: [0, 1] }, { type: 'spring', stiffness: 320, damping: 30 });
		}
		let firstRun = true;
		$effect(() => {
			const c = closing();
			if (firstRun) {
				firstRun = false;
				return;
			}
			if (!c) return;
			if (!functionalMotion()) {
				onClosed();
				return;
			}
			animate(
				target,
				{ opacity: 0 },
				{ type: 'spring', stiffness: 360, damping: 32 }
			).finished.then(() => {
				if (closing()) onClosed();
			});
		});
	};
}

// Cursor-tracking 3D tilt — composes with springHover (different transform components).
export function cardTilt(opts: { max?: number } = {}) {
	const max = opts.max ?? 4;
	return (el: Element) => {
		const target = el as HTMLElement;
		target.style.transformStyle = 'preserve-3d';
		target.style.perspective = '1000px';
		let rect: DOMRect | null = null;
		const onEnter = () => {
			rect = target.getBoundingClientRect();
		};
		const onMove = (e: PointerEvent) => {
			if (!decorativeMotion()) return;
			if (!rect) rect = target.getBoundingClientRect();
			const x = (e.clientX - rect.left) / rect.width - 0.5;
			const y = (e.clientY - rect.top) / rect.height - 0.5;
			animate(
				target,
				{ rotateX: -y * max, rotateY: x * max },
				{ type: 'spring', stiffness: 380, damping: 28, mass: 0.5 }
			);
		};
		const onLeave = () => {
			animate(target, { rotateX: 0, rotateY: 0 }, { type: 'spring', stiffness: 250, damping: 32 });
			rect = null;
		};
		target.addEventListener('pointerenter', onEnter);
		target.addEventListener('pointermove', onMove);
		target.addEventListener('pointerleave', onLeave);
		return () => {
			target.removeEventListener('pointerenter', onEnter);
			target.removeEventListener('pointermove', onMove);
			target.removeEventListener('pointerleave', onLeave);
		};
	};
}

// Scroll-velocity-aware "rubber" — content micro-shifts based on wheel intensity,
// then springs back. Captures the "react to how hard you scroll" feel.
export function scrollRubber(
	opts: { axis?: 'y' | 'x'; max?: number; stiffness?: number; damping?: number } = {}
) {
	const axis = opts.axis ?? 'y';
	const max = opts.max ?? 6;
	const stiffness = opts.stiffness ?? 420;
	const damping = opts.damping ?? 22;
	return (el: Element) => {
		const target = el as HTMLElement;
		let raf = 0;
		let pending = 0;
		const settle = () => {
			animate(target, { [axis]: 0 } as any, { type: 'spring', stiffness, damping, mass: 0.6 });
			raf = 0;
			pending = 0;
		};
		const onWheel = (e: WheelEvent) => {
			if (!decorativeMotion()) return;
			const delta = axis === 'y' ? e.deltaY : e.deltaX;
			// Only apply rubber when at scroll bounds.
			const atTop = target.scrollTop <= 0 && delta < 0;
			const atBottom =
				target.scrollTop + target.clientHeight >= target.scrollHeight - 1 && delta > 0;
			if (axis === 'y' && !atTop && !atBottom) return;
			const intensity = Math.max(-1, Math.min(1, delta / 200));
			pending = Math.max(-max, Math.min(max, pending - intensity * max * 0.6));
			animate(target, { [axis]: pending } as any, { type: 'spring', stiffness: 600, damping: 30 });
			if (raf) clearTimeout(raf);
			raf = window.setTimeout(settle, 120);
		};
		target.addEventListener('wheel', onWheel, { passive: true });
		return () => {
			target.removeEventListener('wheel', onWheel);
			if (raf) clearTimeout(raf);
		};
	};
}

// Delegated press-spring for any descendant matching `selector` — wires hover/press
// once at mount, so we don't need {@attach} on every button.
export function pressSpringDelegate(root: HTMLElement, selector: string) {
	let hovered: HTMLElement | null = null;
	const onMove = (e: PointerEvent) => {
		if (!decorativeMotion()) return;
		const t = (e.target as HTMLElement | null)?.closest?.(selector) as HTMLElement | null;
		if (t === hovered) return;
		if (hovered && !t?.contains(hovered) && !hovered.contains(t as Node)) {
			animate(hovered, { y: 0, scale: 1 }, { type: 'spring', stiffness: 320, damping: 28 });
		}
		if (t && root.contains(t)) {
			animate(t, { y: -2, scale: 1.02 }, { type: 'spring', stiffness: 380, damping: 22 });
		}
		hovered = t;
	};
	const onLeaveRoot = () => {
		if (hovered) {
			animate(hovered, { y: 0, scale: 1 }, { type: 'spring', stiffness: 320, damping: 28 });
			hovered = null;
		}
	};
	const onDown = (e: PointerEvent) => {
		if (!decorativeMotion()) return;
		const t = (e.target as HTMLElement | null)?.closest?.(selector) as HTMLElement | null;
		if (!t || !root.contains(t)) return;
		const h = pointerHardness(e);
		// 0.95 (soft tap) → 0.86 (hard slam)
		const compress = 0.95 - h * 0.09;
		const k = 540 + h * 320;
		animate(t, { scale: compress, y: -2 }, { type: 'spring', stiffness: k, damping: 26 });
	};
	const onUp = (e: PointerEvent) => {
		if (!decorativeMotion()) return;
		const t = (e.target as HTMLElement | null)?.closest?.(selector) as HTMLElement | null;
		if (!t || !root.contains(t)) return;
		const h = Math.max(0, Math.min(1, lastPointerSpeed / 2));
		// Harder press → bigger overshoot (1.08 → 1.14)
		const overshoot = 1.08 + h * 0.06;
		const settle = t === hovered ? 1.02 : 1;
		const settleY = t === hovered ? -2 : 0;
		animate(
			t,
			{ scale: [null, overshoot, settle] as any, y: settleY },
			{ type: 'spring', stiffness: 380, damping: 12, mass: 0.7 }
		);
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

// Spring-driven height collapse for content sections.
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
		let armed = false;
		let last: boolean | null = null;
		setTimeout(() => {
			armed = true;
			last = collapsed();
			if (last) {
				target.style.height = '0px';
				target.style.opacity = '0';
				target.style.marginTop = '0px';
			}
		}, 80);
		$effect(() => {
			const isCollapsed = collapsed();
			if (!armed || isCollapsed === last) return;
			last = isCollapsed;
			target.style.marginTop = isCollapsed ? '0px' : `${naturalMargin}px`;
			if (!functionalMotion()) {
				target.style.height = isCollapsed ? '0px' : 'auto';
				target.style.opacity = isCollapsed ? '0' : '1';
				if (!isCollapsed) target.style.marginTop = '';
				return;
			}
			const to = isCollapsed ? 0 : naturalHeight();
			const opts = isCollapsed
				? { type: 'spring' as const, stiffness: 200, damping: 18, mass: 1.2 }
				: { type: 'spring' as const, stiffness: 180, damping: 16, mass: 1.3 };
			const ctrl = animate(target, { height: to, opacity: isCollapsed ? 0 : 1 }, opts);
			if (!isCollapsed) {
				ctrl.finished.then(() => {
					if (!collapsed()) {
						target.style.height = 'auto';
						target.style.marginTop = '';
					}
				});
			}
		});
	};
}

// ---- Spring Rotate ------------------------------------------------------------
// Animates rotation between two angles driven by a reactive boolean.
// Great for chevron toggles, expand/collapse indicators.
export function springRotate(
	active: () => boolean,
	opts: { rest?: number; on?: number; stiffness?: number; damping?: number } = {}
) {
	const rest = opts.rest ?? 0;
	const on = opts.on ?? 180;
	const stiffness = opts.stiffness ?? 380;
	const damping = opts.damping ?? 22;
	return (el: Element) => {
		const target = el as HTMLElement;
		target.style.rotate = `${active() ? on : rest}deg`;
		let prev = active();
		$effect(() => {
			const next = active();
			if (next === prev) return;
			prev = next;
			if (!functionalMotion()) {
				target.style.rotate = `${next ? on : rest}deg`;
				return;
			}
			animate(
				target,
				{ rotate: next ? on : rest },
				{ type: 'spring', stiffness, damping, mass: 0.7 }
			);
		});
	};
}

// ---- Spring Width -------------------------------------------------------------
// Interpolates width between two pixel values driven by a reactive boolean.
export function springWidth(
	active: () => boolean,
	opts: { rest: number; on: number; stiffness?: number; damping?: number; mass?: number }
) {
	return (el: Element) => {
		const target = el as HTMLElement;
		target.style.width = `${active() ? opts.on : opts.rest}px`;
		let prev = active();
		$effect(() => {
			const next = active();
			if (next === prev) return;
			prev = next;
			if (!functionalMotion()) {
				target.style.width = `${next ? opts.on : opts.rest}px`;
				return;
			}
			animate(
				target,
				{ width: `${next ? opts.on : opts.rest}px` },
				{
					type: 'spring',
					stiffness: opts.stiffness ?? 380,
					damping: opts.damping ?? 22,
					mass: opts.mass ?? 0.7
				}
			);
		});
	};
}

// ---- Spring Pop ---------------------------------------------------------------
// One-shot pop spring — fires when `active` flips false → true.
export function springPop(active: () => boolean) {
	return (el: Element) => {
		const target = el as HTMLElement;
		let prev = active();
		$effect(() => {
			const next = active();
			if (next && !prev && decorativeMotion()) {
				animate(
					target,
					{ scale: [0.92, 1.04, 1] },
					{ type: 'spring', stiffness: 480, damping: 16, mass: 0.9 }
				);
			}
			prev = next;
		});
	};
}
