<script lang="ts">
	import { reveal } from '$lib/motion.svelte';

	const tools = [
		'deploy_from_github',
		'create_database',
		'get_pod_logs',
		'scale_deployment',
		'run_job',
		'create_ingress',
		'get_deployment_metrics',
		'rollback_deployment',
		'exec_in_pod',
		'create_database_backup',
		'validate_dns',
		'get_build_logs',
		'triage_deployment_error',
		'set_env_vars',
		'restore_database_backup'
	];
</script>

<section id="agents" class="section-y scroll-mt-16 bg-shell-50">
	<div class="section-x">
		<div class="grid gap-8 md:grid-cols-2 md:gap-6">
			<div>
				<h2
					{@attach reveal()}
					class="max-w-[24ch] text-4xl font-semibold tracking-tight text-balance text-ink-900 md:text-5xl"
				>
					Let your agent drive.
				</h2>
			</div>
			<div>
				<p {@attach reveal({ index: 1 })} class="max-w-[48ch] text-lg text-pretty text-ink-700">
					Every capability in the dashboard is exposed as an MCP tool, so Claude or any MCP client
					can deploy, provision a database, read the logs, and work out why a pod is crashing.
				</p>
				<div {@attach reveal({ index: 2 })} class="mt-6 flex flex-wrap items-center gap-3">
					<code
						class="rounded-full bg-canvas px-4 py-2 font-mono text-sm text-ink-700 outline-1 -outline-offset-1 outline-[var(--hairline)]"
					>
						https://your-orchard/mcp
					</code>
					<a href="https://docs.orchard.my/mcp/" class="btn btn-md btn-outline">Read the docs</a>
				</div>
			</div>
		</div>
	</div>

	<div {@attach reveal({ index: 3 })} class="marquee-mask mt-14">
		<div class="marquee flex w-max gap-3">
			{#each [0, 1] as copy (copy)}
				<div class="flex gap-3 pr-3" aria-hidden={copy === 1}>
					{#each tools as tool (tool)}
						<span
							class="rounded-full bg-canvas px-4 py-2 font-mono text-[0.8125rem] whitespace-nowrap text-ink-700 outline-1 -outline-offset-1 outline-[var(--hairline)]"
						>
							{tool}
						</span>
					{/each}
				</div>
			{/each}
		</div>
	</div>
</section>

<style>
	.marquee-mask {
		mask-image: linear-gradient(to right, transparent, black 8%, black 92%, transparent);
		overflow: hidden;
	}

	.marquee {
		animation: marquee 48s linear infinite;
	}

	@keyframes marquee {
		to {
			transform: translateX(-50%);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.marquee {
			animation: none;
		}
	}
</style>
