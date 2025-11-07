<script lang="ts">
	import { fade, scale, fly } from 'svelte/transition';
	import {
		user,
		showOnboarding,
		lastAcceptedOrganization,
		apiFetch,
		toasts
	} from '$lib/stores';
	import {
		Loader2,
		User,
		Github,
		PartyPopper,
		ArrowRight,
		Check,
		Link2
	} from 'lucide-svelte';

	type Step = 'profile' | 'github' | 'welcome';

	let currentStep = $state<Step>('profile');
	let firstName = $state($user?.firstName || '');
	let lastName = $state($user?.lastName || '');
	let saving = $state(false);
	let githubLinked = $state(false);
	let checkingGithub = $state(true);
	let githubUsername = $state<string | null>(null);

	const isOpen = $derived($showOnboarding);
	const organization = $derived($lastAcceptedOrganization);
	const currentUser = $derived($user);

	$effect(() => {
		if (isOpen && currentStep === 'github') {
			checkGitHubStatus();
		}
	});

	$effect(() => {
		if (currentUser) {
			firstName = currentUser.firstName || '';
			lastName = currentUser.lastName || '';
		}
	});

	async function checkGitHubStatus() {
		checkingGithub = true;
		try {
			const response = await apiFetch('/apiv1/github/status');
			if (response.ok) {
				const data = await response.json();
				githubLinked = data.linked;
				githubUsername = data.username || null;
			}
		} catch (e) {
			console.error('Failed to check GitHub status:', e);
		} finally {
			checkingGithub = false;
		}
	}

	async function handleProfileSave() {
		saving = true;

		try {
			// Update profile on the backend
			const response = await apiFetch('/apiv1/auth/me', {
				method: 'PATCH',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					firstName: firstName.trim() || undefined,
					lastName: lastName.trim() || undefined
				})
			});

			if (!response.ok) {
				throw new Error('Failed to update profile');
			}

			const updatedUser = await response.json();

			// Update the user store with the new data
			user.set({
				...$user,
				...updatedUser
			});

			toasts.add({
				title: 'Profile updated',
				color: 'success'
			});

			currentStep = 'github';
			await checkGitHubStatus();
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to update profile',
				color: 'error'
			});
		} finally {
			saving = false;
		}
	}

	function handleProfileSkip() {
		currentStep = 'github';
		checkGitHubStatus();
	}

	function handleLinkGithub() {
		window.location.href = '/apiv1/github/link';
	}

	function handleGithubSkip() {
		currentStep = 'welcome';
	}

	function handleGithubNext() {
		currentStep = 'welcome';
	}

	function handleComplete() {
		showOnboarding.hide();
	}

	const steps: { key: Step; label: string }[] = [
		{ key: 'profile', label: 'Profile' },
		{ key: 'github', label: 'GitHub' },
		{ key: 'welcome', label: 'Welcome' }
	];

	function getStepIndex(step: Step): number {
		return steps.findIndex((s) => s.key === step);
	}
</script>

{#if isOpen}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
		transition:fade={{ duration: 150 }}
		role="dialog"
		aria-modal="true"
	>
		<div
			class="card w-full max-w-lg overflow-hidden"
			transition:scale={{ duration: 150, start: 0.95 }}
		>
			<!-- Progress indicator -->
			<div class="flex items-center justify-center gap-2 border-b p-4" style="border-color: var(--surface-border);">
				{#each steps as step, i}
					<div class="flex items-center gap-2">
						<div
							class="flex h-8 w-8 items-center justify-center rounded-full text-sm font-medium transition-colors"
							class:bg-primary-600={getStepIndex(currentStep) >= i}
							class:text-white={getStepIndex(currentStep) >= i}
							style={getStepIndex(currentStep) < i ? 'background-color: var(--control-bg); color: var(--surface-muted);' : ''}
						>
							{#if getStepIndex(currentStep) > i}
								<Check class="h-4 w-4" />
							{:else}
								{i + 1}
							{/if}
						</div>
						{#if i < steps.length - 1}
							<div
								class="h-0.5 w-8 transition-colors"
								class:bg-primary-600={getStepIndex(currentStep) > i}
								style={getStepIndex(currentStep) <= i ? 'background-color: var(--surface-border);' : ''}
							></div>
						{/if}
					</div>
				{/each}
			</div>

			<!-- Step content -->
			<div class="p-6">
				{#if currentStep === 'profile'}
					<div in:fly={{ x: 20, duration: 200 }}>
						<div class="mb-6 text-center">
							<div class="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary-100 dark:bg-primary-900/30">
								<User class="h-7 w-7 text-primary-600" />
							</div>
							<h2 class="text-xl font-semibold" style="color: var(--center-channel-color);">
								Confirm Your Profile
							</h2>
							<p class="mt-1" style="color: var(--surface-muted);">
								Make sure your name looks right
							</p>
						</div>

						<div class="space-y-4">
							<div class="flex gap-4">
								<div class="flex-1 space-y-1">
									<label for="first-name" class="text-xs font-medium uppercase tracking-wide" style="color: var(--surface-muted);">
										First name
									</label>
									<input
										id="first-name"
										type="text"
										class="input"
										bind:value={firstName}
										placeholder="First name"
									/>
								</div>
								<div class="flex-1 space-y-1">
									<label for="last-name" class="text-xs font-medium uppercase tracking-wide" style="color: var(--surface-muted);">
										Last name
									</label>
									<input
										id="last-name"
										type="text"
										class="input"
										bind:value={lastName}
										placeholder="Last name"
									/>
								</div>
							</div>

							{#if currentUser?.imageUrl}
								<div class="flex items-center gap-4 rounded-xl p-4" style="background-color: var(--control-bg);">
									<img
										src={currentUser.imageUrl}
										alt="Profile"
										class="h-14 w-14 rounded-2xl object-cover ring-2 ring-gray-200 dark:ring-gray-700"
									/>
									<div>
										<p class="font-medium" style="color: var(--center-channel-color);">
											{firstName || currentUser.firstName || 'Your'} {lastName || currentUser.lastName || 'Name'}
										</p>
										<p class="text-sm" style="color: var(--surface-muted);">
											{currentUser.email}
										</p>
									</div>
								</div>
							{/if}
						</div>

						<div class="mt-6 flex gap-3">
							<button onclick={handleProfileSkip} class="btn btn-secondary flex-1">
								Skip
							</button>
							<button onclick={handleProfileSave} disabled={saving} class="btn btn-primary flex-1">
								{#if saving}
									<Loader2 class="h-4 w-4 animate-spin" />
								{/if}
								Continue
								<ArrowRight class="h-4 w-4" />
							</button>
						</div>
					</div>
				{:else if currentStep === 'github'}
					<div in:fly={{ x: 20, duration: 200 }}>
						<div class="mb-6 text-center">
							<div class="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-gray-900 dark:bg-white">
								<Github class="h-7 w-7 text-white dark:text-gray-900" />
							</div>
							<h2 class="text-xl font-semibold" style="color: var(--center-channel-color);">
								Connect GitHub
							</h2>
							<p class="mt-1" style="color: var(--surface-muted);">
								Deploy directly from your repositories
							</p>
						</div>

						{#if checkingGithub}
							<div class="flex justify-center py-8">
								<Loader2 class="h-8 w-8 animate-spin text-primary-600" />
							</div>
						{:else if githubLinked}
							<div class="rounded-xl border p-4" style="border-color: var(--surface-border); background-color: var(--control-bg);">
								<div class="flex items-center gap-3">
									<div class="flex h-10 w-10 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/30">
										<Check class="h-5 w-5 text-green-600" />
									</div>
									<div>
										<p class="font-medium" style="color: var(--center-channel-color);">
											GitHub Connected
										</p>
										{#if githubUsername}
											<p class="text-sm" style="color: var(--surface-muted);">
												@{githubUsername}
											</p>
										{/if}
									</div>
								</div>
							</div>

							<div class="mt-6">
								<button onclick={handleGithubNext} class="btn btn-primary w-full">
									Continue
									<ArrowRight class="h-4 w-4" />
								</button>
							</div>
						{:else}
							<div class="space-y-4">
								<div class="rounded-xl border-2 border-dashed p-6 text-center" style="border-color: var(--surface-border);">
									<Github class="mx-auto h-10 w-10 text-gray-400" />
									<p class="mt-3 text-sm" style="color: var(--surface-muted);">
										Link your GitHub account to deploy from your repositories and enable automatic builds.
									</p>
								</div>

								<div class="rounded-xl border p-4" style="border-color: var(--surface-border); background-color: var(--surface-bg);">
									<p class="text-sm font-medium" style="color: var(--center-channel-color);">
										With GitHub you can:
									</p>
									<ul class="mt-2 list-inside list-disc text-sm" style="color: var(--surface-muted);">
										<li>Deploy directly from your repositories</li>
										<li>Auto-build images from commits</li>
										<li>View deployment history with commit info</li>
									</ul>
								</div>
							</div>

							<div class="mt-6 flex gap-3">
								<button onclick={handleGithubSkip} class="btn btn-secondary flex-1">
									Skip for now
								</button>
								<button onclick={handleLinkGithub} class="btn btn-primary flex-1">
									<Link2 class="h-4 w-4" />
									Connect GitHub
								</button>
							</div>
						{/if}
					</div>
				{:else if currentStep === 'welcome'}
					<div in:fly={{ x: 20, duration: 200 }}>
						<div class="text-center">
							<div class="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-primary-100 dark:bg-primary-900/30">
								<PartyPopper class="h-8 w-8 text-primary-600" />
							</div>
							<h2 class="text-2xl font-bold" style="color: var(--center-channel-color);">
								You're all set!
							</h2>
							{#if organization}
								<p class="mt-2" style="color: var(--surface-muted);">
									Welcome to <strong>{organization.name}</strong>. You're ready to start deploying.
								</p>
							{:else}
								<p class="mt-2" style="color: var(--surface-muted);">
									You're ready to start using Orchard.
								</p>
							{/if}

							<div class="mt-8 rounded-xl border p-4 text-left" style="border-color: var(--surface-border); background-color: var(--control-bg);">
								<p class="text-sm font-medium" style="color: var(--center-channel-color);">
									Quick tips to get started:
								</p>
								<ul class="mt-2 space-y-2 text-sm" style="color: var(--surface-muted);">
									<li class="flex items-start gap-2">
										<span class="mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-primary-600 text-xs text-white">1</span>
										Create a workspace to organize your projects
									</li>
									<li class="flex items-start gap-2">
										<span class="mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-primary-600 text-xs text-white">2</span>
										Add a project and configure your deployment
									</li>
									<li class="flex items-start gap-2">
										<span class="mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-primary-600 text-xs text-white">3</span>
										Deploy and watch your app go live
									</li>
								</ul>
							</div>

							<button onclick={handleComplete} class="btn btn-primary mt-6 w-full">
								Get Started
								<ArrowRight class="h-4 w-4" />
							</button>
						</div>
					</div>
				{/if}
			</div>
		</div>
	</div>
{/if}
