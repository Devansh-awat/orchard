<script lang="ts">
	import { user, pendingInvitations } from '$lib/stores';
	import { themeStore } from '$lib/stores/theme';
	import { User, Settings, LogOut, Sun, Moon, Monitor, ChevronUp, Palette, KeyRound, Mail } from 'lucide-svelte';
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

	function isThemeActive(mode: 'light' | 'dark' | 'system') {
		if (mode === 'system') return !activeThemeId;
		if (mode === 'light') return displayMode === 'light' && activeThemeId === 'light';
		if (mode === 'dark') return displayMode === 'dark' && activeThemeId === 'dark';
		return false;
	}
</script>

<div class="user-menu relative">
	<button
		onclick={() => (open = !open)}
		class="user-menu-trigger flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-left"
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
					<User class="h-4 w-4" />
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
		<span class="user-menu-chevron" class:is-open={open}>
			<ChevronUp class="h-4 w-4" />
		</span>
	</button>

	{#if open}
		<div
			class="user-menu-panel absolute bottom-full left-0 right-0 z-50 mb-1 flex flex-col rounded-xl border p-4 text-sm"
			transition:slide={{ axis: 'y', duration: 200 }}
		>
			<!-- User info -->
			<div class="user-menu-profile">
				{#if $user?.imageUrl}
					<img
						src={$user.imageUrl}
						alt={$user.name || $user.username || 'User'}
						class="user-menu-profile-avatar"
					/>
				{:else}
					<div class="user-menu-profile-avatar-fallback">
						<User class="h-5 w-5" />
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
			<div class="user-menu-section">
				<div class="user-menu-theme-group">
					{#each [
						{ mode: 'light' as const, icon: Sun, label: 'Light' },
						{ mode: 'dark' as const, icon: Moon, label: 'Dark' },
						{ mode: 'system' as const, icon: Monitor, label: 'System' }
					] as { mode, icon: Icon, label }}
						<button
							onclick={() => applyQuickTheme(mode)}
							class="user-menu-theme-btn"
							class:is-active={isThemeActive(mode)}
							title={label}
						>
							<Icon class="h-3.5 w-3.5" />
						</button>
					{/each}
				</div>
			</div>

			<!-- Pending invitations banner -->
			{#if $pendingInvitations.length > 0}
				<div class="user-menu-section-footer">
					<a
						href="/user/settings#invitations"
						class="user-menu-item user-menu-item--highlight"
						onclick={() => (open = false)}
					>
						<Mail class="h-4 w-4" />
						{$pendingInvitations.length} pending invitation{$pendingInvitations.length === 1 ? '' : 's'}
						<span class="user-menu-invite-dot"></span>
					</a>
				</div>
			{/if}

			<!-- Navigation links -->
			<div class="user-menu-section-footer">
				<a
					href="/user/settings"
					class="user-menu-item"
					onclick={() => (open = false)}
				>
					<Settings class="h-4 w-4" />
					User Settings
				</a>
				<a
					href="/user/api-tokens"
					class="user-menu-item"
					onclick={() => (open = false)}
				>
					<KeyRound class="h-4 w-4" />
					API Tokens
				</a>
				<a
					href="/user/settings/theme"
					class="user-menu-item"
					onclick={() => (open = false)}
				>
					<Palette class="h-4 w-4" />
					Customize Theme
				</a>
			</div>

			<!-- Sign out -->
			<div class="user-menu-signout">
				<button
					onclick={() => user.signOut()}
					class="user-menu-item is-danger"
				>
					<LogOut class="h-4 w-4" />
					Sign out
				</button>
			</div>
		</div>
	{/if}
</div>
