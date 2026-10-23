<script lang="ts">
	import SectionCard from '$lib/components/ui/SectionCard.svelte';
</script>

<SectionCard title="Type">
	<div class="flex flex-col gap-2">
		<p class="text-display text-fg">Display 32</p>
		<p class="text-title-1 text-fg">Title 1 · 24</p>
		<p class="text-title-2 text-fg">Title 2 · 20</p>
		<p class="text-title-3 text-fg">Title 3 · 17</p>
		<p class="text-headline text-fg">Headline · 15</p>
		<p class="text-body text-fg">
			Body · 14. The quick brown fox deploys over the lazy dog, 0123456789.
		</p>
		<p class="text-callout text-muted">Callout · 13, muted</p>
		<p class="text-caption text-faint">Caption · 12, faint</p>
		<p class="font-mono text-callout text-fg">mono · ERROR 137 OOMKilled at 03:14:07</p>
	</div>
</SectionCard>
