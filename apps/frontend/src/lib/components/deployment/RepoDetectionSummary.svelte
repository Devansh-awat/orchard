<script lang="ts">
	import { Loader2, Sparkles } from 'lucide-svelte';
	import { springPop } from '$lib/utils/motion.svelte';

	let {
		loading = false,
		framework = null,
		buildType = 'dockerfile',
		dockerfilePath = null,
		port = null
	}: {
		loading?: boolean;
		framework?: string | null;
		buildType?: 'dockerfile' | 'railpack';
		dockerfilePath?: string | null;
		port?: number | null;
	} = $props();

	const FRAMEWORK_LABELS: Record<string, string> = {
		nextjs: 'Next.js',
		sveltekit: 'SvelteKit',
		nuxt: 'Nuxt',
		astro: 'Astro',
		remix: 'Remix',
		nestjs: 'NestJS',
		fastify: 'Fastify',
		express: 'Express',
		vite: 'Vite',
		node: 'Node.js',
		go: 'Go',
		python: 'Python',
		ruby: 'Ruby',
		rust: 'Rust',
		php: 'PHP',
		static: 'Static site'
	};

	const frameworkLabel = $derived(framework ? (FRAMEWORK_LABELS[framework] ?? framework) : null);

	const summary = $derived.by(() => {
		const parts: string[] = [];
		if (buildType === 'dockerfile' && dockerfilePath) {
			parts.push(`builds with ${dockerfilePath}`);
		} else if (frameworkLabel) {
			parts.push(`${frameworkLabel} app, built for you automatically`);
		} else {
			parts.push('built for you automatically');
		}
		if (port) {
			parts.push(`listens on ${port}`);
		}
		return parts.join(', ');
	});

	const ready = $derived(!loading);
</script>

{#if loading}
	<div class="detect-strip" role="status">
		<span class="detect-icon"><Loader2 size={14} class="animate-spin" /></span>
		<span class="detect-text">Reading your repository</span>
	</div>
{:else}
	<div class="detect-strip detect-strip--ready" role="status" {@attach springPop(() => ready)}>
		<span class="detect-icon detect-icon--accent"><Sparkles size={14} /></span>
		<span class="detect-text">
			{summary.charAt(0).toUpperCase() + summary.slice(1)}. Everything below is filled in and
			stays editable.
		</span>
	</div>
{/if}

<style>
	.detect-strip {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-top: 0.75rem;
		padding: 0.5rem 0.75rem;
		border-radius: 0.5rem;
		border: 1px solid var(--border-default);
		background: var(--bg-raised);
		font-size: 0.8125rem;
		color: var(--text-muted);
	}

	.detect-strip--ready {
		border-color: color-mix(in srgb, var(--accent) 25%, var(--border-default));
		background: var(--accent-subtle);
		color: var(--text-default);
	}

	.detect-icon {
		display: inline-flex;
		flex-shrink: 0;
	}

	.detect-icon--accent {
		color: var(--accent);
	}

	.detect-text {
		line-height: 1.4;
	}
</style>
