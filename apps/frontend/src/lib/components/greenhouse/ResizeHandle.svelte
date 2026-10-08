<script lang="ts">
	let {
		orientation = 'vertical',
		label,
		value,
		min,
		max,
		active = false,
		onstart,
		ondrag,
		onend,
		onnudge,
		onreset
	}: {
		orientation?: 'vertical' | 'horizontal';
		label: string;
		value: number;
		min: number;
		max: number;
		active?: boolean;
		onstart: () => void;
		ondrag: (delta: number) => void;
		onend: () => void;
		onnudge: (delta: number) => void;
		onreset: () => void;
	} = $props();

	function down(event: PointerEvent) {
		if (event.button !== 0) return;
		event.preventDefault();
		const handle = event.currentTarget as HTMLElement;
		handle.setPointerCapture(event.pointerId);
		const start = orientation === 'vertical' ? event.clientX : event.clientY;
		onstart();

		function move(e: PointerEvent) {
			ondrag((orientation === 'vertical' ? e.clientX : e.clientY) - start);
		}

		function up(e: PointerEvent) {
			handle.releasePointerCapture(e.pointerId);
			handle.removeEventListener('pointermove', move);
			handle.removeEventListener('pointerup', up);
			handle.removeEventListener('pointercancel', up);
			onend();
		}

		handle.addEventListener('pointermove', move);
		handle.addEventListener('pointerup', up);
		handle.addEventListener('pointercancel', up);
	}

	function key(event: KeyboardEvent) {
		const step = event.shiftKey ? 48 : 12;
		const back = orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp';
		const fwd = orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown';
		if (event.key === back) {
			event.preventDefault();
			onnudge(-step);
		} else if (event.key === fwd) {
			event.preventDefault();
			onnudge(step);
		} else if (event.key === 'Enter' || event.key === 'Home') {
			event.preventDefault();
			onreset();
		}
	}
</script>

<div
	class="grip grip--{orientation}"
	class:grip--active={active}
	role="separator"
	aria-label={label}
	aria-orientation={orientation}
	aria-valuenow={Math.round(value)}
	aria-valuemin={Math.round(min)}
	aria-valuemax={Math.round(max)}
	tabindex="0"
	onpointerdown={down}
	ondblclick={onreset}
	onkeydown={key}
></div>

<style>
	.grip {
		position: absolute;
		z-index: 5;
		touch-action: none;
		user-select: none;
		outline: none;
	}

	.grip--vertical {
		top: 0;
		bottom: 0;
		width: 7px;
		margin-left: -3px;
		cursor: col-resize;
	}

	.grip--horizontal {
		left: 0;
		right: 0;
		height: 7px;
		margin-top: -3px;
		cursor: row-resize;
	}

	.grip::after {
		content: '';
		position: absolute;
		background: var(--accent);
		opacity: 0;
		transition: opacity var(--dur-fast) ease;
	}

	.grip--vertical::after {
		top: 0;
		bottom: 0;
		left: 3px;
		width: 1px;
	}

	.grip--horizontal::after {
		left: 0;
		right: 0;
		top: 3px;
		height: 1px;
	}

	.grip:hover::after,
	.grip:focus-visible::after,
	.grip--active::after {
		opacity: 1;
	}

	.grip--vertical:hover::after,
	.grip--vertical:focus-visible::after,
	.grip--vertical.grip--active::after {
		left: 2px;
		width: 3px;
	}

	.grip--horizontal:hover::after,
	.grip--horizontal:focus-visible::after,
	.grip--horizontal.grip--active::after {
		top: 2px;
		height: 3px;
	}
</style>
