<script lang="ts">
	import {
		Book,
		Bot,
		Camera,
		Cloud,
		Code,
		Cpu,
		Database,
		Flame,
		Gamepad2,
		Globe,
		Leaf,
		Music,
		Package,
		Palette,
		Rocket,
		Server,
		Shield,
		Sprout,
		Terminal,
		Zap
	} from 'lucide-svelte';
	import { repoHue, repoInitial } from './format';
	import { githubAvatarUrl, repoIconOf, type RepoGithub, type RepoLucideIcon } from './repo-icon';

	let {
		name,
		github = null,
		icon = null,
		size = 16
	}: {
		name: string;
		github?: RepoGithub | null;
		icon?: string | null;
		size?: 16 | 20;
	} = $props();

	const LUCIDE: Record<RepoLucideIcon, typeof Rocket> = {
		rocket: Rocket,
		globe: Globe,
		server: Server,
		database: Database,
		package: Package,
		terminal: Terminal,
		code: Code,
		book: Book,
		leaf: Leaf,
		sprout: Sprout,
		flame: Flame,
		zap: Zap,
		cpu: Cpu,
		cloud: Cloud,
		shield: Shield,
		palette: Palette,
		'gamepad-2': Gamepad2,
		bot: Bot,
		music: Music,
		camera: Camera
	};

	const shown = $derived(repoIconOf(icon, github));
	const avatar = $derived(shown.kind === 'github' ? githubAvatarUrl(shown.owner) : null);
	let failed = $state<string | null>(null);
	const kind = $derived(avatar && failed === avatar ? 'initial' : shown.kind);
	const Glyph = $derived(shown.kind === 'lucide' ? LUCIDE[shown.name] : null);
</script>

<span
	class="repo-icon repo-icon--{kind}"
	class:repo-icon--lg={size === 20}
	style:--hue="var({repoHue(name)})"
	aria-hidden="true"
>
	{#if kind === 'github' && avatar}
		<img src={avatar} alt="" loading="lazy" decoding="async" onerror={() => (failed = avatar)} />
	{:else if kind === 'lucide' && Glyph}
		<Glyph size={size === 20 ? 14 : 12} strokeWidth={2} style="color: inherit" />
	{:else if kind === 'emoji' && shown.kind === 'emoji'}
		<span class="emoji">{shown.value}</span>
	{:else}
		{repoInitial(name)}
	{/if}
</span>

<style>
	.repo-icon {
		display: inline-grid;
		place-items: center;
		flex: none;
		width: 1rem;
		height: 1rem;
		overflow: hidden;
		border-radius: 0.25rem;
		background: color-mix(in oklab, var(--hue) 22%, var(--gh-editor, var(--bg-surface)));
		color: color-mix(in oklab, var(--hue) 80%, var(--text-default));
		font-size: var(--text-micro);
		line-height: 1;
		font-weight: 600;
		user-select: none;
	}

	.repo-icon--lg {
		width: 1.25rem;
		height: 1.25rem;
		border-radius: 0.3125rem;
		font-size: var(--text-caption);
	}

	.repo-icon--emoji {
		background: color-mix(in oklab, var(--text-default) 6%, transparent);
	}

	.repo-icon--github {
		background: color-mix(in oklab, var(--text-default) 8%, transparent);
		box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--text-default) 10%, transparent);
	}

	.emoji {
		font-size: 0.6875rem;
		line-height: 1;
	}

	.repo-icon--lg .emoji {
		font-size: 0.875rem;
	}

	img {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
</style>
