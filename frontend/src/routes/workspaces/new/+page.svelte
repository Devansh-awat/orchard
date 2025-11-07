<script lang="ts">
	import { goto } from '$app/navigation';
	import { organizations, selectedOrganization, apiFetch, toasts, refreshTree } from '$lib/stores';
	import { ArrowLeft, Loader2, Building2, Check, ChevronDown } from 'lucide-svelte';
	import { Select, Progress } from 'melt/builders';
	import { scale } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import NumberFlow from '@number-flow/svelte';

	let name = $state('');
	let slug = $state('');
	let description = $state('');
	let selectedOrgId = $state('');
	let submitting = $state(false);
	let showingProgress = $state(false);
	let error = $state<string | null>(null);
	let autoSlug = $state(true);

	// Progress animation
	const PROGRESS_DURATION = 3000;
	let progressValue = $state(0);
	let progressAnimationFrame: number | null = null;
	const progress = new Progress();
	const value = $derived(Math.round(progressValue));

	function scaleConvert(value: number, from: [number, number], to: [number, number]) {
		const [minA, maxA] = from;
		const [minB, maxB] = to;
		return ((value - minA) / (maxA - minA)) * (maxB - minB) + minB;
	}

	function clamp(min: number, value: number, max: number) {
		return Math.min(Math.max(value, min), max);
	}

	function cancelProgressAnimation() {
		if (progressAnimationFrame) {
			cancelAnimationFrame(progressAnimationFrame);
			progressAnimationFrame = null;
		}
	}

	function startProgressAnimation() {
		if (typeof window === 'undefined') return;
		cancelProgressAnimation();
		progressValue = 0;

		const start = performance.now();

		const tick = (now: number) => {
			const elapsed = Math.min((now - start) / PROGRESS_DURATION, 1);
			progressValue = Math.min(100, cubicOut(elapsed) * 100);

			if (elapsed < 1 && showingProgress) {
				progressAnimationFrame = requestAnimationFrame(tick);
			} else {
				progressAnimationFrame = null;
			}
		};

		progressAnimationFrame = requestAnimationFrame(tick);
	}

	$effect(() => {
		if (typeof window === 'undefined') return;

		if (showingProgress) {
			startProgressAnimation();
		} else {
			cancelProgressAnimation();
			progressValue = 0;
		}

		return () => {
			cancelProgressAnimation();
		};
	});

	$effect(() => {
		progress.value = progressValue;
	});

	const dark = {
		h: 34,
		maxS: 81.01,
		s: () => Math.min(scaleConvert(value, [0, 60], [0, dark.maxS]), dark.maxS),
		minL: 65.1,
		l: () => clamp(dark.minL, scaleConvert(value, [0, 80], [100, dark.minL]), 100),
	};

	const darkClr = $derived(`hsl(${dark.h}, ${dark.s()}%, ${dark.l()}%)`);

	const light = {
		h: 34,
		maxS: 81.01,
		s: () => Math.min(scaleConvert(value, [0, 60], [0, light.maxS]), light.maxS),
		maxL: 65.1,
		l: () => clamp(40, scaleConvert(value, [0, 80], [0, light.maxL]), light.maxL),
	};

	const lightClr = $derived(`hsl(${light.h}, ${light.s()}%, ${light.l()}%)`);

	const clrClasses = "text-[var(--light)] dark:text-[var(--dark)]";
	const bgClasses = "bg-[var(--light)] dark:bg-[var(--dark)]";
	const clrStyle = $derived(`--light: ${lightClr}; --dark: ${darkClr};`);

	// Initialize selected org
	$effect(() => {
		if ($selectedOrganization && !selectedOrgId) {
			selectedOrgId = $selectedOrganization.id;
		}
	});

	// Get selected org name for display
	const selectedOrgName = $derived.by(() => {
		if (!selectedOrgId) return null;
		return $organizations.find(o => o.id === selectedOrgId)?.name || null;
	});

	// Derived value for Select
	const selectedOrgForSelect = $derived.by(() => selectedOrgId || null);

	// Create Melt Select for organizations
	const orgSelect = new Select<string, false>({
		selected: selectedOrgForSelect,
		onSelectedChange: ({ selected }) => {
			selectedOrgId = selected || '';
		}
	});

	// Auto-generate slug from name
	$effect(() => {
		if (autoSlug && name) {
			slug = name
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, '-')
				.replace(/^-|-$/g, '');
		}
	});

	function handleSlugInput() {
		autoSlug = false;
	}

	async function submit() {
		if (!name.trim()) {
			error = 'Workspace name is required';
			return;
		}

		if (!slug.trim()) {
			error = 'Workspace slug is required';
			return;
		}

		if (!selectedOrgId) {
			error = 'Please select an organization';
			return;
		}

		submitting = true;
		showingProgress = true;
		error = null;

		const fakeDelay = new Promise(resolve => setTimeout(resolve, 3000));

		try {
			const response = await apiFetch('/apiv1/workspaces', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					name: name.trim(),
					slug: slug.trim(),
					description: description.trim() || undefined,
					organizationId: selectedOrgId
				})
			});

			const data = await response.json().catch(() => ({}));

			if (!response.ok) {
				await fakeDelay;
				throw new Error(data.message || 'Failed to create workspace');
			}

			await fakeDelay;
			const workspace = data;

			toasts.add({
				title: 'Workspace created',
				description: `${workspace.name} has been created successfully`,
				color: 'success'
			});

			refreshTree();
			goto(`/workspaces/${workspace.slug}`);
		} catch (e) {
			await fakeDelay;
			error = e instanceof Error ? e.message : 'Failed to create workspace';
			showingProgress = false;
		} finally {
			submitting = false;
		}
	}
</script>

<div class="relative min-h-full">
	<div class="p-6">
		<button
			onclick={() => window.history.back()}
			class="mb-6 inline-flex items-center gap-2 text-sm cursor-pointer"
			style="color: var(--surface-muted);"
			onmouseenter={(e) => e.currentTarget.style.color = 'var(--center-channel-color)'}
			onmouseleave={(e) => e.currentTarget.style.color = 'var(--surface-muted)'}
		>
			<ArrowLeft class="h-4 w-4" />
			Back to workspace
		</button>

		<div class="mx-auto max-w-2xl space-y-6">
			<!-- Header -->
			<div
				class="rounded-3xl border p-6 shadow-sm"
				style="background-color: var(--surface-bg); border-color: var(--surface-border); color: var(--center-channel-color);"
			>
				<p class="text-xs uppercase tracking-wide" style="color: var(--surface-muted);">Create</p>
				<h1 class="mt-1 text-2xl font-bold" style="color: var(--center-channel-color);">New Workspace</h1>
				<p class="mt-2 text-sm" style="color: var(--surface-muted);">
					Create a new workspace to organize your projects and deployments.
				</p>
			</div>

			{#if error}
				<div class="alert alert-error">{error}</div>
			{/if}

				<div class="card">
					<div class="card-body">
						<div class="relative">
							<div class={['space-y-6', showingProgress ? 'opacity-0' : '']}>
							<!-- Organization Selection -->
							<div class="relative">
								<label {...orgSelect.label} class="mb-2 block text-sm font-medium" style="color: var(--center-channel-color);">
									Organization
								</label>
								<button
									{...orgSelect.trigger}
									class="flex w-full items-center justify-between overflow-hidden rounded-xl border py-2 pl-3 pr-4 text-left transition hover:cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
									style="background-color: var(--control-bg); color: var(--center-channel-color); border-color: var(--surface-border);"
									onmouseenter={(e) => {
										if (!e.currentTarget.disabled) {
											e.currentTarget.style.backgroundColor = 'var(--control-hover-bg)';
										}
									}}
									onmouseleave={(e) => {
										e.currentTarget.style.backgroundColor = 'var(--control-bg)';
									}}
								>
									<div class="inline-flex items-center gap-2 overflow-hidden">
										<Building2 class="h-4 w-4 shrink-0" />
										<span class="truncate">{selectedOrgName || 'Select organization'}</span>
									</div>
									<ChevronDown class="h-4 w-4 shrink-0" />
								</button>

								{#if orgSelect.open}
									<div
										{...orgSelect.content}
										class="absolute z-20 mt-1 flex w-full flex-col rounded-xl border p-2 shadow"
										style="background-color: var(--surface-bg); border-color: var(--surface-border); color: var(--center-channel-color);"
										transition:scale={{ duration: 150, start: 0.96 }}
									>
										<div
											{...orgSelect.getOption('', 'Select organization')}
											class="relative flex items-center justify-between rounded-xl py-2 pl-8 pr-2 transition"
											class:font-semibold={orgSelect.selected === ''}
											style="background-color: {orgSelect.highlighted === '' ? 'var(--control-hover-bg)' : 'transparent'};"
										>
											<span>Select organization</span>
											{#if orgSelect.isSelected('')}
												<Check class="h-4 w-4 font-bold" style="color: var(--link-color);" />
											{/if}
										</div>
										{#each $organizations as org}
											<div
												{...orgSelect.getOption(org.id, org.name)}
												class="relative flex items-center justify-between rounded-xl py-2 pl-8 pr-2 transition"
												class:font-semibold={orgSelect.selected === org.id}
												style="background-color: {orgSelect.highlighted === org.id ? 'var(--control-hover-bg)' : 'transparent'};"
											>
												<span>{org.name}</span>
												{#if orgSelect.isSelected(org.id)}
													<Check class="h-4 w-4 font-bold" style="color: var(--link-color);" />
												{/if}
											</div>
										{/each}
									</div>
								{/if}
							</div>

							<!-- Workspace Name -->
							<div>
								<label for="name" class="mb-2 block text-sm font-medium" style="color: var(--center-channel-color);">
									Workspace name
								</label>
								<input
									id="name"
									type="text"
									bind:value={name}
									placeholder="My Workspace"
									class="input rounded-xl"
									style="background-color: var(--control-bg); color: var(--center-channel-color); border-color: var(--surface-border);"
								/>
							</div>

							<!-- Workspace Slug -->
							<div>
								<label for="slug" class="mb-2 block text-sm font-medium" style="color: var(--center-channel-color);">
									Workspace slug
								</label>
								<input
									id="slug"
									type="text"
									bind:value={slug}
									oninput={handleSlugInput}
									placeholder="my-workspace"
									class="input rounded-xl font-mono"
									style="background-color: var(--control-bg); color: var(--center-channel-color); border-color: var(--surface-border);"
								/>
								<p class="mt-1 text-xs" style="color: var(--surface-muted);">
									Used in URLs and Kubernetes namespace generation
								</p>
							</div>

							<!-- Description -->
							<div>
								<label for="description" class="mb-2 block text-sm font-medium" style="color: var(--center-channel-color);">
									Description (optional)
								</label>
								<textarea
									id="description"
									bind:value={description}
									placeholder="A brief description of this workspace"
									rows="3"
									class="input rounded-xl"
									style="background-color: var(--control-bg); color: var(--center-channel-color); border-color: var(--surface-border);"
								></textarea>
							</div>

							<!-- Preview -->
							{#if selectedOrgId && slug}
								{@const selectedOrg = $organizations.find(o => o.id === selectedOrgId)}
								{#if selectedOrg}
									<div
										class="rounded-2xl border p-4"
										style="background-color: var(--control-bg); border-color: var(--surface-border); color: var(--center-channel-color);"
									>
										<p class="text-sm font-medium" style="color: var(--center-channel-color);">Namespace preview</p>
										<code class="mt-1 block text-sm font-mono" style="color: var(--link-color);">
											{selectedOrg.slug}-{slug}
										</code>
									</div>
								{/if}
							{/if}

							<!-- Actions -->
							<div
								class="flex items-center justify-end gap-3 pt-4 border-t"
								style="border-color: var(--surface-border);"
							>
								<a href="/" class="btn btn-secondary">
									Cancel
								</a>
								<button
									onclick={submit}
									disabled={submitting}
									class="btn btn-primary"
								>
									{#if submitting}
										<Loader2 class="h-4 w-4 animate-spin" />
									{/if}
									Create workspace
								</button>
							</div>
						</div>

						{#if showingProgress}
							<div
								class="absolute inset-0 z-10 flex items-center justify-center rounded-2xl"
								style="background-color: var(--center-channel-bg);"
							>
						<div class="flex flex-col items-center gap-2" style={clrStyle}>
							<span
								class="origin-bottom font-semibold"
								style={`color: var(--link-color); scale: ${scaleConvert(value, [0, 100], [1, 2])};`}
							>
								<NumberFlow {value} suffix="%" />
							</span>
				<div
					{...progress.root}
					class="relative w-[300px] overflow-hidden rounded-full"
					style="background-color: var(--surface-border);"
					style:height={`${scaleConvert(value, [0, 100], [8, 24])}px`}
				>
					<div
						{...progress.progress}
						class="h-full rounded-full"
						style={`width: ${progressValue}%; transition: width 120ms linear; background-color: var(--link-color);`}
					></div>
				</div>
			</div>
							</div>
						{/if}
					</div>
				</div>
			</div>
		</div>
	</div>
</div>
