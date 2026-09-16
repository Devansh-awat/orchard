<script lang="ts">
	import './home-page.css';
	import '$lib/components/login/login.css';
	import AsciiVine from '$lib/components/AsciiVine.svelte';
	import { Button, Skeleton } from '$lib/components/ui';
	import { EmailAuthPanel, ProviderButtons } from '$lib/components/login';
	import type { LoginProvider, DiscoveredOrg } from '$lib/components/login';
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { get } from 'svelte/store';
	import {
		user,
		isSignedIn,
		apiFetch,
		selectedOrganization,
		organizations,
		toasts,
		pendingInvitations,
		showPendingInvitationsModal
	} from '$lib/stores';
	import type { User } from '$lib/stores';
	import {
		Plus,
		Users,
		FolderKanban,
		Rocket,
		Database,
		Globe,
		ArrowRight,
		Search,
		Sparkles
	} from 'lucide-svelte';

	interface Workspace {
		id: string;
		name: string;
		slug: string;
		description?: string;
		organizationId: string;
		members?: unknown[];
		projects?: unknown[];
		_count?: {
			members: number;
			projects: number;
		};
		createdAt: string;
	}

	let workspaces = $state<Workspace[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);

	let deploymentCount = $state(0);
	let databaseCount = $state(0);
	let ingressCount = $state(0);

	let greeting = $derived.by(() => {
		const hour = new Date().getHours();
		if (hour < 12) return 'Good morning';
		if (hour < 18) return 'Good afternoon';
		return 'Good evening';
	});

	let userName = $derived.by(() => {
		const u = $user;
		if (!u) return '';
		return u.firstName || u.name || u.username || u.email?.split('@')[0] || '';
	});
	let blocked = $state<'private_beta' | 'signups_disabled' | null>(null);

	const vineTone =
		browser && document.documentElement.classList.contains('dark') ? 'dark' : 'light';

	// Sign-in options come from the API: instance-wide identity providers an
	// admin configured, plus the env-configured one when there is one. Nothing
	// about which providers exist is baked into this page.
	let providers = $state<LoginProvider[]>([]);
	let providersLoaded = $state(false);
	let loginEmail = $state('');
	let loginCode = $state('');
	let discovered = $state<DiscoveredOrg | null>(null);

	async function fetchProviders() {
		try {
			const res = await apiFetch('/apiv1/sso/providers');
			if (res.ok) providers = await res.json();
		} catch {
			providers = [];
		} finally {
			providersLoaded = true;
		}
	}

	/**
	 * Work-email routing: if the address belongs to an org running its own
	 * IdP, hand the sign-in over to that org's login page instead of emailing
	 * a code that its enforcement policy would reject anyway.
	 */
	async function routeToOrgSso(email: string): Promise<boolean> {
		try {
			const res = await apiFetch('/apiv1/sso/discover', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email })
			});
			if (!res.ok) return false;
			const data = await res.json();
			if (!data?.organization) return false;
			discovered = data.organization as DiscoveredOrg;
			if (discovered.enforced) {
				await goto(discovered.loginUrl);
				return true;
			}
			return false;
		} catch {
			return false;
		}
	}

	async function fetchWorkspaces() {
		loading = true;
		error = null;

		try {
			const [wsRes, depRes, dbRes, ingRes] = await Promise.all([
				apiFetch('/apiv1/projects'),
				apiFetch('/apiv1/deployments').catch(() => null),
				apiFetch('/apiv1/databases').catch(() => null),
				apiFetch('/apiv1/ingresses').catch(() => null)
			]);

			if (!wsRes.ok) {
				throw new Error('Failed to fetch workspaces');
			}
			workspaces = await wsRes.json();

			if (depRes?.ok) {
				const deps = await depRes.json();
				deploymentCount = Array.isArray(deps) ? deps.length : 0;
			}
			if (dbRes?.ok) {
				const dbs = await dbRes.json();
				databaseCount = Array.isArray(dbs) ? dbs.length : 0;
			}
			if (ingRes?.ok) {
				const ings = await ingRes.json();
				ingressCount = Array.isArray(ings) ? ings.length : 0;
			}
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to fetch workspaces';
		} finally {
			loading = false;
		}
	}

	// Filter workspaces by selected organization
	let organizationWorkspaces = $derived.by(() => {
		if (!$selectedOrganization) return workspaces;
		return workspaces.filter((w) => w.organizationId === $selectedOrganization.id);
	});

	let searchQuery = $state('');

	let filteredWorkspaces = $derived.by(() => {
		const query = searchQuery.trim().toLowerCase();
		if (!query) return organizationWorkspaces;
		return organizationWorkspaces.filter((workspace) => {
			const name = workspace.name.toLowerCase();
			const slug = workspace.slug.toLowerCase();
			const description = workspace.description?.toLowerCase() ?? '';
			return name.includes(query) || slug.includes(query) || description.includes(query);
		});
	});

	function openWorkspace(slug: string) {
		return goto(`/workspaces/${slug}`);
	}

	function handleWorkspaceClick(event: MouseEvent, slug: string) {
		if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
			return;
		}

		event.preventDefault();
		openWorkspace(slug);
	}

	onMount(() => {
		if ($isSignedIn) {
			if ($user?.setupCompleted === false) {
				goto('/setup', { replaceState: true });
				return;
			}
			const slug = organizations.getDefaultSlug();
			if (slug) {
				goto(`/${slug}`, { replaceState: true });
				return;
			}
			fetchWorkspaces();
		} else {
			loading = false;
			fetchProviders();

			// A link minted by `orchardctl login` on the host lands here with
			// both halves in the query string; redeeming it is the panel's job.
			const params = new URLSearchParams(window.location.search);
			const linkEmail = params.get('email');
			const linkCode = params.get('code');
			if (linkEmail && linkCode) {
				loginEmail = linkEmail;
				loginCode = linkCode;
				history.replaceState(null, '', window.location.pathname);
			}
		}
	});

	async function refreshUserContext(skipUserFetch = false) {
		if (!skipUserFetch) {
			await user.fetchUser();
		}

		if (get(isSignedIn)) {
			try {
				const response = await apiFetch('/apiv1/organizations/user');
				if (response.ok) {
					const orgs = await response.json();
					organizations.set(orgs);
					organizations.initializeSelected();
				}
			} catch (err) {
				console.error('Failed to refresh organizations after sign-in', err);
			}
		}
	}

	async function handlePostAuth(message: string, signedInUser?: User) {
		if (signedInUser) {
			user.set(signedInUser);
		}

		await refreshUserContext(Boolean(signedInUser));

		if (get(isSignedIn)) {
			const currentUser = get(user);

			// New user — redirect to setup
			if (currentUser?.setupCompleted === false) {
				goto('/setup', { replaceState: true });
				return;
			}

			// Existing user — check for pending invitations
			const pending = await pendingInvitations.fetchPending();
			if (pending.length > 0) {
				showPendingInvitationsModal.show();
			}

			const slug = organizations.getDefaultSlug();
			if (slug) {
				toasts.add({ title: message, color: 'success' });
				goto(`/${slug}`, { replaceState: true });
				return;
			}
		}

		toasts.add({
			title: message,
			color: 'success'
		});
	}
</script>

{#if !$isSignedIn}
	<div class="lg2-page">
		<div class="lg-vine" aria-hidden="true">
			<AsciiVine class="lg-vine-canvas" tone={vineTone} seed={23} band={[0.25, 0.7]} />
		</div>
		<div class="lg2-grid">
			<div class="lg2-hero">
				<img src="/logo/logocolor.svg" alt="Orchard" class="lg2-logo logo-light" />
				<img src="/logo/logocolordm.svg" alt="Orchard" class="lg2-logo logo-dark" />
				<h1 class="lg2-headline">Welcome <em>back</em>.</h1>
			</div>
			<div class="lg2-card">
				{#if blocked}
					<div class="lg-beta">
						<h2 class="lg-beta-title">
							{blocked === 'signups_disabled' ? 'Signups disabled' : 'Private beta'}
						</h2>
						<p class="lg-beta-desc">
							{blocked === 'signups_disabled'
								? 'Signups are disabled on this Orchard instance. Contact your administrator for access.'
								: 'Orchard is currently in private beta. You need an invitation from an existing organization to access the platform.'}
						</p>
						<Button
							variant="primary"
							class="lg-wide"
							onclick={() => {
								blocked = null;
							}}
						>
							Back to sign in
						</Button>
					</div>
				{:else}
					{#if providers.length}
						<ProviderButtons {providers} />
						<div class="lg-divider"><span>or</span></div>
					{:else if !providersLoaded}
						<Skeleton height="2.25rem" />
						<div class="lg-divider"><span>or</span></div>
					{/if}

					<EmailAuthPanel
						bind:email={loginEmail}
						initialCode={loginCode}
						onAuthenticated={handlePostAuth}
						onBlocked={(reason) => {
							blocked = reason;
						}}
						onSsoRedirect={routeToOrgSso}
					/>

					{#if discovered && !discovered.enforced}
						<a class="lg-org-hint" href={discovered.loginUrl}>
							Sign in through {discovered.name} instead
						</a>
					{/if}
				{/if}
			</div>
		</div>
	</div>
{:else}
	<!-- Dashboard for authenticated users -->
	<div class="hp">
		<div class="hp-grid-bg"></div>
		<div class="hp-topbar">
			<div>
				<h1 class="hp-greeting">{greeting}{userName ? `, ${userName}` : ''}</h1>
			</div>
			<a href="/workspaces/new" class="hp-new-btn">
				<Plus size={15} />
				New Workspace
			</a>
		</div>

		{#if error}
			<div class="hp-error">{error}</div>
		{/if}

		{#if loading}
			<div class="hp-stats">
				{#each Array(4) as _, i (i)}
					<div class="hp-stat">
						<div
							class="skeleton"
							style="width: 2rem; height: 2rem; border-radius: var(--radius-sm);"
						></div>
						<div class="hp-stat-info">
							<div class="skeleton" style="width: 2rem; height: 1.25rem;"></div>
							<div class="skeleton" style="width: 4rem; height: 0.75rem;"></div>
						</div>
					</div>
				{/each}
			</div>
			<div class="hp-grid">
				{#each Array(4) as _, i (i)}
					<div class="hp-card hp-skeleton-card">
						<div class="hp-card-top">
							<div class="skeleton skeleton-icon"></div>
						</div>
						<div class="hp-card-body">
							<div class="skeleton skeleton-title"></div>
							<div class="skeleton skeleton-desc"></div>
						</div>
						<div class="hp-card-footer">
							<div class="skeleton skeleton-badge"></div>
							<div class="skeleton skeleton-badge"></div>
						</div>
					</div>
				{/each}
			</div>
		{:else}
			<div class="hp-stats">
				<div class="hp-stat">
					<div class="hp-stat-icon hp-stat-icon--workspaces">
						<FolderKanban size={18} />
					</div>
					<div class="hp-stat-info">
						<span class="hp-stat-value">{organizationWorkspaces.length}</span>
						<span class="hp-stat-label">Workspaces</span>
					</div>
				</div>
				<div class="hp-stat">
					<div class="hp-stat-icon hp-stat-icon--deployments">
						<Rocket size={18} />
					</div>
					<div class="hp-stat-info">
						<span class="hp-stat-value">{deploymentCount}</span>
						<span class="hp-stat-label">Apps</span>
					</div>
				</div>
				<div class="hp-stat">
					<div class="hp-stat-icon hp-stat-icon--databases">
						<Database size={18} />
					</div>
					<div class="hp-stat-info">
						<span class="hp-stat-value">{databaseCount}</span>
						<span class="hp-stat-label">Databases</span>
					</div>
				</div>
				<div class="hp-stat">
					<div class="hp-stat-icon hp-stat-icon--ingresses">
						<Globe size={18} />
					</div>
					<div class="hp-stat-info">
						<span class="hp-stat-value">{ingressCount}</span>
						<span class="hp-stat-label">Ingresses</span>
					</div>
				</div>
			</div>

			<div class="hp-section">
				<div class="hp-section-header">
					<h2 class="hp-section-title">Workspaces</h2>
					{#if organizationWorkspaces.length > 3}
						<div class="hp-search-wrap">
							<Search size={14} class="hp-search-icon" />
							<input
								type="search"
								placeholder="Filter..."
								class="hp-search"
								bind:value={searchQuery}
							/>
						</div>
					{/if}
				</div>

				{#if !organizationWorkspaces.length}
					<div class="hp-empty hp-empty--dashed">
						<div class="hp-empty-icon">
							<Sparkles size={24} />
						</div>
						<h3 class="hp-empty-title">Create your first workspace</h3>
						<p class="hp-empty-desc">
							Workspaces help you organize projects, deployments, and team members.
						</p>
						<a href="/workspaces/new" class="hp-new-btn">
							<Plus size={16} />
							Create Workspace
						</a>
					</div>
				{:else if filteredWorkspaces.length}
					<div class="hp-grid">
						{#each filteredWorkspaces as workspace (workspace.id)}
							<a
								href={`/workspaces/${workspace.slug}`}
								onclick={(event) => handleWorkspaceClick(event, workspace.slug)}
								class="hp-card"
							>
								<div class="hp-card-top">
									<div class="hp-card-icon">
										<FolderKanban size={18} />
									</div>
									<div class="hp-card-arrow">
										<ArrowRight size={14} />
									</div>
								</div>
								<div class="hp-card-body">
									<span class="hp-card-name">{workspace.name}</span>
									{#if workspace.description}
										<span class="hp-card-desc">{workspace.description}</span>
									{/if}
								</div>
								<div class="hp-card-footer">
									<span class="hp-card-count">
										<FolderKanban size={11} />
										{workspace._count?.projects ?? workspace.projects?.length ?? 0}
									</span>
									<span class="hp-card-count">
										<Users size={11} />
										{workspace._count?.members ?? workspace.members?.length ?? 0}
									</span>
								</div>
							</a>
						{/each}
					</div>
				{:else}
					<div class="hp-empty">
						<p>No workspaces match "{searchQuery}"</p>
					</div>
				{/if}
			</div>
		{/if}
	</div>
{/if}
