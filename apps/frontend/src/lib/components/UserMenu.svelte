<script lang="ts">
	import { user, pendingInvitations } from '$lib/stores';
	import { themeStore } from '$lib/stores/theme';
	import { Moon, Monitor, Palette, Mail } from 'lucide-svelte';
	import { User, Settings, LogOut, Sun, ChevronUp, KeyRound } from '@jis3r/icons';
	import { browser } from '$app/environment';
	import { animate } from 'motion';

	interface Props {
		collapsed?: boolean;
	}
	let { collapsed = false }: Props = $props();

	let open = $state(false);
	let render = $state(false);
	$effect(() => {
		if (open) render = true;
	});

	let activeThemeId = $state<string | null>(null);
	let activeTheme = $state<typeof import('$lib/stores/theme').defaultLightTheme | null>(null);

	$effect(() => {
		const unsubId = themeStore.activeThemeId.subscribe((val) => {
			activeThemeId = val;
		});
		const unsubTheme = themeStore.activeTheme.subscribe((val) => {
			activeTheme = val;
		});
		return () => {
			unsubId();
			unsubTheme();
		};
	});

	let displayMode = $derived.by(() => {
		if (!activeThemeId) return 'system';
		if (activeThemeId === 'light') return 'light';
		if (activeThemeId === 'dark') return 'dark';
		return activeTheme?.isDark ? 'dark' : 'light';
	});

	function applyQuickTheme(mode: 'light' | 'dark' | 'system') {
		if (mode === 'system') {
			themeStore.setSystemTheme();
		} else if (mode === 'light') {
			themeStore.setActiveTheme('light');
		} else {
			themeStore.setActiveTheme('dark');
		}
	}

	$effect(() => {
		if (browser) {
			themeStore.init();
		}
	});

	function handleClickOutside(event: MouseEvent) {
		const target = event.target as HTMLElement;
		if (!target.closest('.user-menu')) {
			open = false;
		}
	}

	$effect(() => {
		if (open) {
			document.addEventListener('click', handleClickOutside);
			return () => document.removeEventListener('click', handleClickOutside);
		}
	});

	function isThemeActive(mode: 'light' | 'dark' | 'system') {
		if (mode === 'system') return !activeThemeId;
		if (mode === 'light') return displayMode === 'light' && activeThemeId === 'light';
		if (mode === 'dark') return displayMode === 'dark' && activeThemeId === 'dark';
		return false;
	}

	// Physics primitives — same vocabulary as the project page / sidebar.
	function motionPopover(opts: {
		from?: { opacity?: number; scale?: number; y?: number };
		stiffness?: number;
		damping?: number;
		mass?: number;
		closing: () => boolean;
		onClosed: () => void;
	}) {
		const from = {
			opacity: opts.from?.opacity ?? 0,
			scale: opts.from?.scale ?? 0.96,
			y: opts.from?.y ?? 6
		};
		const stiffness = opts.stiffness ?? 520;
		const damping = opts.damping ?? 30;
		const mass = opts.mass ?? 0.85;
		return (el: Element) => {
			const target = el as HTMLElement;
			animate(
				target,
				{ opacity: [from.opacity, 1], scale: [from.scale, 1], y: [from.y, 0] },
				{ type: 'spring', stiffness, damping, mass }
			);
			let firstRun = true;
			$effect(() => {
				const closing = opts.closing();
				if (firstRun) {
					firstRun = false;
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

	function motionStagger(index: number, stride = 0.03) {
		return (el: Element) => {
			const target = el as HTMLElement;
			animate(
				target,
				{ opacity: [0, 1], y: [4, 0] },
				{ type: 'spring', stiffness: 320, damping: 26, mass: 0.7, delay: index * stride }
			);
		};
	}

	function springHover(opts: { lift?: number; stiffness?: number; damping?: number } = {}) {
		const { lift = -1, stiffness = 380, damping = 22 } = opts;
		return (el: Element) => {
			const t = el as HTMLElement;
			const enter = () => {
				animate(t, { y: lift }, { type: 'spring', stiffness, damping });
				t.querySelectorAll('[role="img"]').forEach((icon) => {
					icon.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
				});
			};
			const leave = () =>
				animate(t, { y: 0 }, { type: 'spring', stiffness: stiffness * 0.8, damping: damping + 4 });
			const press = () =>
				animate(t, { scale: 0.97 }, { type: 'spring', stiffness: 600, damping: 28 });
			const release = () =>
				animate(t, { scale: 1 }, { type: 'spring', stiffness: 420, damping: 18 });
			t.addEventListener('mouseenter', enter);
			t.addEventListener('mouseleave', leave);
			t.addEventListener('pointerdown', press);
			t.addEventListener('pointerup', release);
			t.addEventListener('pointerleave', release);
			return () => {
				t.removeEventListener('mouseenter', enter);
				t.removeEventListener('mouseleave', leave);
				t.removeEventListener('pointerdown', press);
				t.removeEventListener('pointerup', release);
				t.removeEventListener('pointerleave', release);
			};
		};
	}

	function springRotate(active: () => boolean, on = 180) {
		return (el: Element) => {
			const t = el as HTMLElement;
			t.style.transform = `rotate(${active() ? on : 0}deg)`;
			let prev = active();
			$effect(() => {
				const next = active();
				if (next === prev) return;
				prev = next;
				animate(
					t,
					{ rotate: next ? on : 0 },
					{ type: 'spring', stiffness: 380, damping: 24, mass: 0.7 }
				);
			});
		};
	}

	// Theme button pop on activation.
	function springPop(active: () => boolean) {
		return (el: Element) => {
			const t = el as HTMLElement;
			let prev = active();
			$effect(() => {
				const next = active();
				if (next && !prev) {
					animate(
						t,
						{ scale: [0.88, 1.08, 1] },
						{ type: 'spring', stiffness: 480, damping: 16, mass: 0.85 }
					);
				}
				prev = next;
			});
		};
	}
</script>

<div class="user-menu relative" class:is-collapsed={collapsed}>
	{#if collapsed}
		<button
			onclick={() => (open = !open)}
			class="user-menu-trigger-collapsed"
			class:is-open={open}
			aria-label="User menu"
			{@attach springHover()}
		>
			{#if $user?.imageUrl}
				<img
					src={$user.imageUrl}
					alt={$user.name || $user.username || 'User'}
					class="h-9 w-9 rounded-xl object-cover"
				/>
			{:else}
				<div class="sidebar-footer-avatar">
					{#if $user?.username || $user?.name || $user?.firstName}
						<span class="text-sm font-medium"
							>{($user?.username || $user?.name || $user?.firstName || 'U')
								.charAt(0)
								.toUpperCase()}</span
						>
					{:else}
						<User size={16} />
					{/if}
				</div>
			{/if}
			{#if $pendingInvitations.length > 0}
				<span class="sidebar-notification-dot"></span>
			{/if}
			{#if !open}
				<span class="sidebar-collapsed-tooltip">
					{$user?.username || $user?.name || $user?.firstName || 'User'}
				</span>
			{/if}
		</button>
	{:else}
		<button
			onclick={() => (open = !open)}
			class="user-menu-trigger flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-left"
			{@attach springHover({ lift: -1 })}
		>
			<div class="relative">
				{#if $user?.imageUrl}
					<img
						src={$user.imageUrl}
						alt={$user.name || $user.username || 'User'}
						class="h-8 w-8 rounded-lg object-cover"
					/>
				{:else}
					<div class="user-menu-avatar-fallback">
						<User size={16} />
					</div>
				{/if}
				{#if $pendingInvitations.length > 0}
					<span class="user-menu-notification-dot"></span>
				{/if}
			</div>
			<div class="flex-1 text-left min-w-0">
				<p class="user-menu-name truncate text-sm font-medium">
					{$user?.username || $user?.name || $user?.firstName || 'User'}
				</p>
			</div>
			<span class="user-menu-chevron" class:is-open={open} {@attach springRotate(() => open, 180)}>
				<ChevronUp size={16} />
			</span>
		</button>
	{/if}

	{#if render}
		<div
			class="user-menu-panel absolute bottom-full z-50 mb-1 flex flex-col rounded-xl border p-4 text-sm"
			class:user-menu-panel-collapsed={collapsed}
			class:left-0={!collapsed}
			class:right-0={!collapsed}
			style:transform-origin="bottom left"
			{@attach motionPopover({
				from: { y: 8, scale: 0.96 },
				stiffness: 540,
				damping: 30,
				closing: () => !open,
				onClosed: () => {
					render = false;
				}
			})}
		>
			<!-- User info -->
			<div class="user-menu-profile" {@attach motionStagger(0)}>
				{#if $user?.imageUrl}
					<img
						src={$user.imageUrl}
						alt={$user.name || $user.username || 'User'}
						class="user-menu-profile-avatar"
					/>
				{:else}
					<div class="user-menu-profile-avatar-fallback">
						<User size={20} />
					</div>
				{/if}
				<div class="user-menu-profile-info">
					<p class="user-menu-name text-sm font-semibold">
						{$user?.name || $user?.firstName || $user?.username}
					</p>
					<p class="user-menu-email text-xs">
						@{$user?.username || $user?.name || 'user'}
					</p>
				</div>
			</div>

			<!-- Theme switcher -->
			<div class="user-menu-section" {@attach motionStagger(1)}>
				<div class="user-menu-theme-group">
					{#each [{ mode: 'light' as const, icon: Sun, label: 'Light' }, { mode: 'dark' as const, icon: Moon, label: 'Dark' }, { mode: 'system' as const, icon: Monitor, label: 'System' }] as { mode, icon: Icon, label } (mode)}
						<button
							onclick={() => applyQuickTheme(mode)}
							class="user-menu-theme-btn"
							class:is-active={isThemeActive(mode)}
							title={label}
							{@attach springPop(() => isThemeActive(mode))}
						>
							<Icon size={14} />
						</button>
					{/each}
				</div>
			</div>

			<!-- Pending invitations banner -->
			{#if $pendingInvitations.length > 0}
				<div class="user-menu-section-footer" {@attach motionStagger(2)}>
					<a
						href="/user/settings#invitations"
						class="user-menu-item user-menu-item--highlight"
						onclick={() => (open = false)}
						{@attach springHover({ lift: -1 })}
					>
						<Mail size={16} />
						{$pendingInvitations.length} pending invitation{$pendingInvitations.length === 1
							? ''
							: 's'}
						<span class="user-menu-invite-dot"></span>
					</a>
				</div>
			{/if}

			<!-- Navigation links -->
			<div class="user-menu-section-footer" {@attach motionStagger(3)}>
				<a
					href="/user/settings"
					class="user-menu-item"
					onclick={() => (open = false)}
					{@attach springHover({ lift: -1 })}
				>
					<Settings size={16} />
					User Settings
				</a>
				<a
					href="/user/mcp"
					class="user-menu-item"
					onclick={() => (open = false)}
					{@attach springHover({ lift: -1 })}
				>
					<svg class="h-4 w-4" viewBox="0 0 180 180" fill="none" xmlns="http://www.w3.org/2000/svg"
						><path
							d="M18 84.8528L85.8822 16.9706C95.2548 7.59798 110.451 7.59798 119.823 16.9706C129.196 26.3431 129.196 41.5391 119.823 50.9117L68.5581 102.177"
							stroke="currentColor"
							stroke-width="12"
							stroke-linecap="round"
						/><path
							d="M69.2652 101.47L119.823 50.9117C129.196 41.5391 144.392 41.5391 153.765 50.9117L154.118 51.2652C163.491 60.6378 163.491 75.8338 154.118 85.2063L92.7248 146.6C89.6006 149.724 89.6006 154.789 92.7248 157.913L105.331 170.52"
							stroke="currentColor"
							stroke-width="12"
							stroke-linecap="round"
						/><path
							d="M102.853 33.9411L52.6482 84.1457C43.2756 93.5183 43.2756 108.714 52.6482 118.087C62.0208 127.459 77.2167 127.459 86.5893 118.087L136.794 67.8822"
							stroke="currentColor"
							stroke-width="12"
							stroke-linecap="round"
						/></svg
					>
					MCP Server
				</a>
				<a
					href="/user/api-tokens"
					class="user-menu-item"
					onclick={() => (open = false)}
					{@attach springHover({ lift: -1 })}
				>
					<KeyRound size={16} />
					API Tokens
				</a>
				<a
					href="/user/settings/theme"
					class="user-menu-item"
					onclick={() => (open = false)}
					{@attach springHover({ lift: -1 })}
				>
					<Palette size={16} />
					Customize Theme
				</a>
			</div>

			<!-- Sign out -->
			<div class="user-menu-signout" {@attach motionStagger(4)}>
				<button
					onclick={() => user.signOut()}
					class="user-menu-item is-danger"
					{@attach springHover({ lift: -1 })}
				>
					<LogOut size={16} />
					Sign out
				</button>
			</div>
		</div>
	{/if}
</div>

<style>
	.user-menu.is-collapsed {
		position: relative;
		display: flex;
		justify-content: center;
	}
	.user-menu-trigger-collapsed {
		position: relative;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.25rem;
		height: 2.25rem;
		padding: 0;
		border-radius: 0.75rem;
		background-color: transparent;
		color: var(--sidebar-text);
		transition:
			background-color 120ms ease,
			box-shadow 120ms ease;
		cursor: pointer;
	}
	.user-menu-trigger-collapsed:hover {
		background-color: var(--sidebar-text-hover-bg);
	}
	.user-menu-trigger-collapsed.is-open {
		background-color: var(--sidebar-text-active-bg);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--sidebar-text-active-border) 40%, transparent);
	}
	.user-menu-trigger-collapsed:hover .sidebar-collapsed-tooltip {
		opacity: 1;
	}
	.user-menu-trigger-collapsed .sidebar-notification-dot {
		top: -2px;
		right: -2px;
	}

	.user-menu-panel.user-menu-panel-collapsed {
		left: calc(100% + 0.5rem);
		right: auto;
		bottom: 0;
		width: 17rem;
		margin-bottom: 0;
	}

	.user-menu-trigger {
		background-color: transparent;
		color: var(--sidebar-text);
		transition: background-color 150ms ease;
	}

	.user-menu-trigger:hover {
		background-color: var(--sidebar-text-hover-bg);
	}

	.user-menu-avatar-fallback {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		border-radius: 0.5rem;
		flex-shrink: 0;
		background-color: color-mix(in srgb, var(--sidebar-text-active-border) 15%, transparent);
		color: var(--sidebar-text-active-border);
	}

	.user-menu-name {
		color: var(--sidebar-text);
	}

	.user-menu-panel .user-menu-name {
		color: var(--center-channel-color);
	}

	.user-menu-email {
		color: color-mix(in srgb, var(--sidebar-text) 55%, transparent);
	}

	.user-menu-panel .user-menu-email {
		color: var(--surface-muted);
	}

	.user-menu-chevron {
		color: color-mix(in srgb, var(--sidebar-text) 45%, transparent);
		transition: transform 200ms ease;
	}

	.user-menu-chevron.is-open {
		transform: rotate(180deg);
	}

	.user-menu-panel {
		background-color: var(--surface-bg);
		border-color: var(--surface-border);
		color: var(--center-channel-color);
		box-shadow:
			0 4px 6px rgb(0 0 0 / 0.04),
			0 12px 32px rgb(0 0 0 / 0.1);
		gap: 0.25rem;
		overflow: hidden;
	}

	.user-menu-profile {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding-bottom: 0.75rem;
		margin-bottom: 0.25rem;
		border-bottom: 1px solid var(--surface-border);
	}

	.user-menu-profile-avatar {
		width: 2.25rem;
		height: 2.25rem;
		border-radius: 0.625rem;
		object-fit: cover;
		flex-shrink: 0;
	}

	.user-menu-profile-avatar-fallback {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.25rem;
		height: 2.25rem;
		border-radius: 0.625rem;
		flex-shrink: 0;
		background-color: color-mix(in srgb, var(--sidebar-text-active-border) 12%, transparent);
		color: var(--sidebar-text-active-border);
	}

	.user-menu-profile-info {
		min-width: 0;
		flex: 1;
	}

	.user-menu-signout {
		border-top: 1px solid var(--surface-border);
		padding-top: 0.25rem;
		margin-top: 0.25rem;
	}

	.user-menu-section {
		padding: 0.375rem 0;
	}

	.user-menu-theme-group {
		display: flex;
		gap: 0.125rem;
		background-color: color-mix(in srgb, var(--center-channel-color) 6%, transparent);
		border-radius: 0.375rem;
		padding: 0.125rem;
		min-width: 0;
		width: 100%;
		box-sizing: border-box;
	}

	.user-menu-theme-btn {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.25rem;
		padding: 0.25rem 0;
		border-radius: 0.25rem;
		font-size: 0.6875rem;
		font-weight: 500;
		color: var(--surface-muted);
		background: transparent;
		transition:
			background-color 150ms ease,
			color 150ms ease;
	}

	.user-menu-theme-btn:hover {
		color: var(--center-channel-color);
		background-color: color-mix(in srgb, var(--center-channel-color) 8%, transparent);
	}

	.user-menu-theme-btn.is-active {
		background-color: var(--surface-bg);
		color: var(--center-channel-color);
		box-shadow: 0 1px 3px color-mix(in srgb, #000 10%, transparent);
	}

	.user-menu-section-footer {
		padding-top: 0.25rem;
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
	}

	.user-menu-item {
		display: flex;
		width: 100%;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem;
		font-size: 0.875rem;
		border-radius: 0.5rem;
		color: var(--center-channel-color);
		background: transparent;
		transition: background-color 120ms ease;
	}

	.user-menu-item:hover {
		background-color: var(--control-hover-bg);
	}

	.user-menu-item.is-danger {
		color: var(--error-text-color);
	}

	.user-menu-item.is-danger:hover {
		background-color: color-mix(in srgb, var(--error-text-color) 10%, transparent);
	}

	.user-menu-item.user-menu-item--highlight {
		color: var(--button-bg);
		font-weight: 550;
	}

	.user-menu-item.user-menu-item--highlight:hover {
		background-color: color-mix(in srgb, var(--button-bg) 8%, transparent);
	}

	.user-menu-invite-dot {
		width: 0.375rem;
		height: 0.375rem;
		border-radius: 50%;
		background-color: var(--sidebar-text-active-border);
		flex-shrink: 0;
		margin-left: auto;
		animation: invite-pulse 2s ease-in-out infinite;
	}

	.user-menu-notification-dot {
		position: absolute;
		top: -2px;
		right: -2px;
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 50%;
		background-color: var(--sidebar-text-active-border);
		border: 2px solid var(--sidebar-bg);
		animation: invite-pulse 2s ease-in-out infinite;
	}

	.sidebar-notification-dot {
		position: absolute;
		top: -1px;
		right: -1px;
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 50%;
		background-color: var(--sidebar-text-active-border);
		border: 2px solid var(--sidebar-bg);
		animation: invite-pulse 2s ease-in-out infinite;
	}

	@keyframes invite-pulse {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.5;
		}
	}

	.sidebar-footer-avatar {
		display: flex;
		width: 2.25rem;
		height: 2.25rem;
		align-items: center;
		justify-content: center;
		border-radius: 0.75rem;
		background-color: var(--sidebar-text-hover-bg);
		color: var(--sidebar-text);
		transition: background-color 120ms ease;
	}
	.sidebar-footer-avatar:hover {
		background-color: var(--sidebar-text-active-bg);
	}
</style>
