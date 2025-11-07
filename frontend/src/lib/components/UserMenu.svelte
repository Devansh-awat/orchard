<script lang="ts">
	import { user } from '$lib/stores';
	import { themeStore } from '$lib/stores/theme';
	import { User, Settings, LogOut, Sun, Moon, Monitor, ChevronUp, Palette } from 'lucide-svelte';
	import { browser } from '$app/environment';
	import { slide } from 'svelte/transition';
	import { get } from 'svelte/store';

	let open = $state(false);
	let activeThemeId = $state<string | null>(null);
	let activeTheme = $state<typeof import('$lib/stores/theme').defaultLightTheme | null>(null);

	// Subscribe to the stores
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

	// Determine display mode: 'light', 'dark', or 'system'
	let displayMode = $derived.by(() => {
		if (!activeThemeId) return 'system';
		if (activeThemeId === 'light') return 'light';
		if (activeThemeId === 'dark') return 'dark';
		// For custom themes, show based on isDark
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
</script>

<div class="user-menu relative">
	<button
		onclick={() => (open = !open)}
		class="user-menu-trigger flex w-full items-center gap-3 rounded-xl px-4 py-2 text-sm font-medium transition-all text-left"
		class:shadow-md={open}
	>
		{#if $user?.imageUrl}
			<img
				src={$user.imageUrl}
				alt={$user.name || $user.username || 'User'}
				class="h-8 w-8 rounded-lg object-cover"
			/>
		{:else}
			<div
				class="flex h-8 w-8 items-center justify-center rounded-lg"
				style="background-color: var(--sidebar-text-hover-bg); color: var(--sidebar-text);"
			>
				<User class="h-4 w-4" />
			</div>
		{/if}
		<div class="flex-1 text-left min-w-0">
			<p class="truncate text-sm font-medium" style="color: var(--sidebar-text);">
				{$user?.name || $user?.firstName || $user?.username || 'User'}
			</p>
			<p class="truncate text-xs" style="color: var(--surface-muted);">
				{$user?.email || ''}
			</p>
		</div>
		<span class="transition-transform duration-200 {open ? 'rotate-180' : ''}">
			<ChevronUp
				class="h-4 w-4"
				style="color: var(--surface-muted);"
			/>
		</span>
	</button>

	{#if open}
		<div
			class="user-menu-panel absolute bottom-full left-0 right-0 z-50 mb-1 flex flex-col gap-2 rounded-xl border p-4 text-sm shadow-lg"
			transition:slide={{ axis: 'y', duration: 200 }}
		>
			<div class="pb-2 border-b" style="border-color: var(--divider-color);">
				<p class="text-sm font-medium" style="color: var(--sidebar-text);">
					{$user?.name || $user?.username}
				</p>
				<p class="text-xs" style="color: var(--surface-muted);">
					{$user?.email}
				</p>
			</div>

			<div class="py-2">
				<div class="flex items-center justify-between px-2 py-1">
					<p class="text-xs font-medium uppercase" style="color: var(--surface-muted);">
						Theme
					</p>
					<a
						href="/user/settings/theme"
						class="text-xs font-medium transition-colors"
						style="color: var(--link-color);"
						onclick={() => (open = false)}
					>
						<span class="flex items-center gap-1">
							<Palette class="h-3 w-3" />
							Customize
						</span>
					</a>
				</div>
				<div class="flex gap-1">
					<button
						onclick={() => applyQuickTheme('light')}
						class="user-menu-theme-btn flex flex-1 items-center justify-center gap-1 rounded px-2 py-1.5 text-xs transition {displayMode === 'light' && activeThemeId === 'light' ? 'bg-primary-100 text-primary-700 dark:bg-primary-900/30 dark:text-primary-400' : ''}"
						style={!(displayMode === 'light' && activeThemeId === 'light') ? 'color: var(--sidebar-text);' : ''}
					>
						<Sun class="h-3 w-3" />
						Light
					</button>
					<button
						onclick={() => applyQuickTheme('dark')}
						class="user-menu-theme-btn flex flex-1 items-center justify-center gap-1 rounded px-2 py-1.5 text-xs transition {displayMode === 'dark' && activeThemeId === 'dark' ? 'bg-primary-100 text-primary-700 dark:bg-primary-900/30 dark:text-primary-400' : ''}"
						style={!(displayMode === 'dark' && activeThemeId === 'dark') ? 'color: var(--sidebar-text);' : ''}
					>
						<Moon class="h-3 w-3" />
						Dark
					</button>
					<button
						onclick={() => applyQuickTheme('system')}
						class="user-menu-theme-btn flex flex-1 items-center justify-center gap-1 rounded px-2 py-1.5 text-xs transition {!activeThemeId ? 'bg-primary-100 text-primary-700 dark:bg-primary-900/30 dark:text-primary-400' : ''}"
						style={activeThemeId ? 'color: var(--sidebar-text);' : ''}
					>
						<Monitor class="h-3 w-3" />
						System
					</button>
				</div>
			</div>

			<div class="border-t pt-2" style="border-color: var(--divider-color);">
				<a
					href="/user/settings"
					class="user-menu-item flex items-center gap-2 px-2 py-2 text-sm transition rounded-lg"
					style="color: color-mix(in srgb, var(--sidebar-text) 85%, var(--center-channel-bg));"
				>
					<Settings class="h-4 w-4" />
					Settings
				</a>
				<button
					onclick={() => user.signOut()}
					class="user-menu-item flex w-full items-center gap-2 px-2 py-2 text-sm transition rounded-lg"
					style="color: var(--error-text-color);"
				>
					<LogOut class="h-4 w-4" />
					Sign out
				</button>
			</div>
		</div>
	{/if}
</div>
