<script lang="ts">
	import { themeStore } from '../stores/theme';
	import { Sun, Moon, Monitor } from 'lucide-svelte';

	let activeId = $derived.by(() => {
		let id: string | null = null;
		themeStore.activeThemeId.subscribe((v) => (id = v))();
		return id;
	});

	let mode = $derived<'light' | 'dark' | 'system'>(
		activeId === 'light' ? 'light' : activeId === 'dark' ? 'dark' : 'system'
	);
</script>

<div
	class="inline-flex gap-0.5 rounded-lg p-0.5"
	style="background-color: color-mix(in srgb, var(--surface-border) 50%, transparent);"
>
	<button
		type="button"
		class="flex items-center justify-center gap-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors"
		class:bg-primary-600={mode === 'light'}
		class:text-white={mode === 'light'}
		style={mode !== 'light' ? 'color: var(--center-channel-color);' : ''}
		onclick={() => themeStore.setActiveTheme('light')}
		aria-label="Light theme"
	>
		<Sun class="h-3.5 w-3.5" />
		Light
	</button>
	<button
		type="button"
		class="flex items-center justify-center gap-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors"
		class:bg-primary-600={mode === 'dark'}
		class:text-white={mode === 'dark'}
		style={mode !== 'dark' ? 'color: var(--center-channel-color);' : ''}
		onclick={() => themeStore.setActiveTheme('dark')}
		aria-label="Dark theme"
	>
		<Moon class="h-3.5 w-3.5" />
		Dark
	</button>
	<button
		type="button"
		class="flex items-center justify-center gap-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors"
		class:bg-primary-600={mode === 'system'}
		class:text-white={mode === 'system'}
		style={mode !== 'system' ? 'color: var(--center-channel-color);' : ''}
		onclick={() => themeStore.setSystemTheme()}
		aria-label="System theme"
	>
		<Monitor class="h-3.5 w-3.5" />
		System
	</button>
</div>
