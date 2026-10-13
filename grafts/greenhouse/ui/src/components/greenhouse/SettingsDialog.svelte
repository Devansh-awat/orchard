<script lang="ts">
	import { untrack } from 'svelte';
	import { BookOpen, X } from 'lucide-svelte';
	import { Avatar, Button, Select } from '@orchard/graft-ui';
	import { iconAnimation, motion, motionPopover } from '@orchard/graft-ui/utils/motion.svelte';
	import { getGreenhouseApp } from './app.svelte';
	import { ago, runnerLabel } from './format';
	import MachineUsagePanel from './MachineUsagePanel.svelte';
	import AgentsSection from './settings/AgentsSection.svelte';
	import ContextSection from './settings/ContextSection.svelte';
	import AppearanceSection from './settings/AppearanceSection.svelte';
	import DangerSection from './settings/DangerSection.svelte';
	import GeneralSection from './settings/GeneralSection.svelte';
	import GitSection from './settings/GitSection.svelte';
	import IntegrationsSection from './settings/IntegrationsSection.svelte';
	import PreferencesSection from './settings/PreferencesSection.svelte';
	import ProjectsSection from './settings/ProjectsSection.svelte';
	import SectionIcon from './settings/SectionIcon.svelte';
	import Pip from './mascot/Pip.svelte';
	import SetupSection from './settings/SetupSection.svelte';
	import ShortcutsSection from './settings/ShortcutsSection.svelte';
	import SoundsSection from './settings/SoundsSection.svelte';
	import {
		DEFAULT_SECTION,
		MACHINE_SECTIONS,
		PERSONAL_SECTIONS,
		SECTION_LABELS,
		canonicalSection,
		isSettingsSection,
		type SettingsSectionId
	} from './settings/sections';

	let { open = $bindable(false) }: { open?: boolean } = $props();

	const DOCS = 'https://orchard.my/docs/greenhouse';
	const ACCOUNT = '/user/settings?tab=profile';

	const app = getGreenhouseApp();
	const machine = $derived(app.machine);
	const ws = $derived(app.ws);
	const owner = $derived(ws?.isOwner ?? false);
	const hasMachine = $derived(!!machine && !!ws && !ws.lifecycleOnly);
	const requested = $derived(app.settingsSection);

	const groups = $derived([
		...(hasMachine
			? [
					{
						label: 'Machine',
						ids: MACHINE_SECTIONS
					}
				]
			: []),
		{ label: 'You', ids: PERSONAL_SECTIONS }
	]);
	const ids = $derived(groups.flatMap((g) => g.ids));

	let section = $state<SettingsSectionId>(DEFAULT_SECTION);
	const current = $derived(ids.includes(section) ? section : ids[0]);

	const facts = $derived(
		machine
			? [
					runnerLabel(machine.runner),
					machine.diskObserved ? `${machine.diskObserved} disk` : null,
					`created ${ago(machine.createdAt)}`,
					machine.lastActiveAt ? `active ${ago(machine.lastActiveAt)}` : null
				]
					.filter(Boolean)
					.join(' · ')
			: ''
	);

	const subtitle = $derived(
		(
			{
				general: facts,
				setup: 'Runs once, on first boot',
				projects: 'Variables from Orchard projects',
				usage: machine?.name ?? '',
				danger: machine?.name ?? '',
				preferences: 'Saved on this device',
				sounds: '',
				appearance: 'Saved on this device',
				git: 'Saved on this device',
				agents: hasMachine ? (machine?.name ?? '') : '',
				integrations: 'Start sessions from issues and chat',
				shortcuts: ''
			} satisfies Record<SettingsSectionId, string>
		)[current]
	);

	let hoverId = $state<SettingsSectionId | null>(null);
	let headHover = $state(false);

	let dialogEl = $state<HTMLDialogElement | null>(null);
	let panelEl = $state<HTMLElement | null>(null);
	let rendered = $state(false);
	let tabEls = $state<Partial<Record<SettingsSectionId, HTMLButtonElement>>>({});
	let wasOpen = false;
	let lastRequest: unknown = undefined;
	let moves = 0;

	$effect(() => {
		const isOpen = open;
		const want = requested;
		if (isOpen && (!wasOpen || want !== lastRequest)) {
			untrack(() => {
				moves = 0;
				section = isSettingsSection(want) ? canonicalSection(want) : DEFAULT_SECTION;
			});
		}
		wasOpen = isOpen;
		lastRequest = want;
	});

	$effect(() => {
		if (open) rendered = true;
	});

	$effect(() => {
		if (!dialogEl || dialogEl.open) return;
		dialogEl.showModal();
		untrack(() => tabEls[current])?.focus({ preventScroll: true });
	});

	function close() {
		open = false;
	}

	function finishClose() {
		dialogEl?.close();
		rendered = false;
	}

	function onBackdrop(e: MouseEvent) {
		if (e.target === dialogEl) close();
	}

	function onCancel(e: Event) {
		e.preventDefault();
		close();
	}

	function select(id: SettingsSectionId) {
		if (id === current) return;
		moves += 1;
		section = id;
		if (panelEl) panelEl.scrollTop = 0;
	}

	function focusPanel() {
		const field = panelEl?.querySelector<HTMLElement>(
			'input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), a[href], [tabindex="0"]'
		);
		(field ?? panelEl)?.focus({ preventScroll: true });
	}

	function onNavKey(e: KeyboardEvent) {
		if (e.defaultPrevented || e.isComposing) return;
		const list = ids;
		const at = list.indexOf(current);
		let next: number | null = null;
		if (e.key === 'ArrowDown') next = (at + 1) % list.length;
		else if (e.key === 'ArrowUp') next = (at - 1 + list.length) % list.length;
		else if (e.key === 'Home') next = 0;
		else if (e.key === 'End') next = list.length - 1;
		else if (e.key === 'ArrowRight' || (e.key === 'Enter' && e.target === tabEls[current])) {
			e.preventDefault();
			focusPanel();
			return;
		}
		if (next === null) return;
		e.preventDefault();
		const id = list[next];
		select(id);
		tabEls[id]?.focus();
	}

	function hoverTo(set: (on: boolean) => void) {
		return (node: HTMLElement) => {
			const on = () => set(true);
			const off = () => set(false);
			node.addEventListener('mouseenter', on);
			node.addEventListener('mouseleave', off);
			return () => {
				node.removeEventListener('mouseenter', on);
				node.removeEventListener('mouseleave', off);
			};
		};
	}

	function navKeys(node: HTMLElement) {
		node.addEventListener('keydown', onNavKey);
		return () => node.removeEventListener('keydown', onNavKey);
	}

	function enter(node: HTMLElement) {
		if (moves === 0) return;
		node.classList.add('motion-entering');
		const run = motion(node, { opacity: [0, 1], y: [6, 0] }, 'snappy');
		if (run) run.finished.then(() => node.classList.remove('motion-entering'));
		else node.classList.remove('motion-entering');
	}
</script>

{#if rendered}
	<dialog
		bind:this={dialogEl}
		class="ui-modal settings"
		class:ui-modal--closing={!open}
		aria-labelledby="gh-settings-title"
		onclick={onBackdrop}
		oncancel={onCancel}
		onclose={() => {
			if (open) close();
			rendered = false;
		}}
		{@attach motionPopover({
			closing: () => !open,
			onClosed: finishClose,
			from: { opacity: 0, scale: 0.98, y: 8 }
		})}
	>
		<nav class="rail" aria-label="Settings sections">
			<h2 class="rail-title" id="gh-settings-title">Settings</h2>
			<div class="tabs" {@attach navKeys}>
				{#each groups as group (group.label)}
					<p class="group" id="gh-settings-group-{group.label}">{group.label}</p>
					<ul class="list" aria-labelledby="gh-settings-group-{group.label}">
						{#each group.ids as id (id)}
							<li>
								<button
									type="button"
									class="tab"
									data-section={id}
									class:tab--on={id === current}
									aria-current={id === current ? 'page' : undefined}
									tabindex={id === current ? 0 : -1}
									bind:this={tabEls[id]}
									onclick={() => select(id)}
									onmouseenter={() => (hoverId = id)}
									onmouseleave={() => (hoverId = null)}
								>
									<SectionIcon {id} animate={iconAnimation(hoverId === id)} />
									<span class="tab-label">{SECTION_LABELS[id]}</span>
								</button>
							</li>
						{/each}
					</ul>
				{/each}
			</div>

			<div class="rail-foot">
				<button
					type="button"
					class="tab"
					onclick={() => {
						close();
						window.dispatchEvent(new Event('greenhouse-tour'));
					}}
				>
					<Pip size={16} playing={false} />
					<span class="tab-label">Take the tour</span>
				</button>
				<a class="tab" href={DOCS} target="_blank" rel="noreferrer">
					<BookOpen size={16} strokeWidth={1.75} />
					<span class="tab-label">Docs</span>
				</a>
				{#if app.self}
					<div class="me">
						<span class="gh-face me-face">
							<Avatar
								user={{ id: app.self.id, name: app.self.name, imageUrl: app.self.avatarUrl }}
								size={28}
							/>
						</span>
						<span class="me-text">
							<span class="me-name">{app.self.name}</span>
							<a class="me-link" href={ACCOUNT}>Manage account</a>
						</span>
					</div>
				{/if}
			</div>
		</nav>

		<section class="pane">
			<header class="head">
				<div class="pick">
					<Select
						value={current}
						aria-label="Section"
						onchange={(e: Event) =>
							select((e.currentTarget as HTMLSelectElement).value as SettingsSectionId)}
					>
						{#each groups as group (group.label)}
							<optgroup label={group.label}>
								{#each group.ids as id (id)}
									<option value={id}>{SECTION_LABELS[id]}</option>
								{/each}
							</optgroup>
						{/each}
					</Select>
				</div>
				<div class="heading" {@attach hoverTo((on) => (headHover = on))}>
					<span class="tile" class:tile--danger={current === 'danger'}>
						<SectionIcon id={current} size={18} animate={iconAnimation(headHover)} />
					</span>
					<span class="heading-text">
						<h3 class="title">{SECTION_LABELS[current]}</h3>
						{#if subtitle}<p class="subtitle" title={subtitle}>{subtitle}</p>{/if}
					</span>
				</div>
				<button
					type="button"
					class="gh-ibtn close"
					aria-label="Close"
					title="Close"
					onclick={close}
				>
					<X size={16} strokeWidth={1.75} />
				</button>
			</header>

			<div class="body gh-scroll" tabindex="-1" bind:this={panelEl}>
				{#key current}
					<div
						class="section"
						data-tour={current === 'context' ? 'context' : undefined}
						{@attach enter}
					>
						{#if current === 'preferences'}
							<PreferencesSection />
						{:else if current === 'sounds'}
							<SoundsSection />
						{:else if current === 'appearance'}
							<AppearanceSection />
						{:else if current === 'git'}
							<GitSection />
						{:else if current === 'agents'}
							<AgentsSection ws={hasMachine ? ws : null} />
						{:else if current === 'context'}
							<ContextSection />
						{:else if current === 'integrations'}
							<IntegrationsSection />
						{:else if current === 'shortcuts'}
							<ShortcutsSection />
						{:else if machine && ws}
							{#if current === 'general'}
								<GeneralSection {machine} {ws} />
								<h4 class="sub">Setup script</h4>
								<SetupSection {machine} owner={ws.isOwner} />
								<h4 class="sub">Projects</h4>
								<ProjectsSection {machine} {ws} />
								{#if owner}
									<h4 class="sub sub--danger">Danger zone</h4>
									<DangerSection {machine} onclose={close} />
								{/if}
							{:else if current === 'usage'}
								<MachineUsagePanel {machine} owner={ws.isOwner} />
							{/if}
						{/if}
					</div>
				{/key}
			</div>

			<footer class="foot">
				<Button variant="secondary" onclick={close}>Close</Button>
			</footer>
		</section>
	</dialog>
{/if}

<style>
	.settings.ui-modal {
		--settings-rule: color-mix(in oklab, var(--text-default) 22%, transparent);
		width: min(var(--modal-room), 55rem);
		height: min(40rem, calc(100dvh - 2rem));
		max-height: none;
		flex-direction: row;
		overflow: hidden;
		border: 1px solid var(--gh-line);
		border-radius: var(--gh-r-sheet);
		background: var(--gh-editor);
		color: var(--gh-text);
		font-size: var(--gh-ui);
		line-height: var(--gh-lh-ui);
		box-shadow:
			0 1px 2px color-mix(in oklab, black 16%, transparent),
			0 24px 48px -16px color-mix(in oklab, black 48%, transparent);
	}

	.rail {
		display: flex;
		flex-direction: column;
		flex: none;
		width: 13.75rem;
		min-height: 0;
		padding: 1.5rem 0.75rem 1rem;
		overflow-y: auto;
		background: var(--gh-sidebar);
		border-right: 1px solid var(--gh-line-soft);
	}

	.rail-title {
		margin: 0 0 1rem;
		padding: 0 0.5rem;
		font-size: var(--text-body);
		line-height: 1.5rem;
		font-weight: 600;
		color: var(--gh-text);
	}

	.tabs {
		display: flex;
		flex-direction: column;
	}

	.group {
		display: flex;
		align-items: center;
		height: 1.75rem;
		margin: 1rem 0 0;
		padding: 0 0.5rem;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		font-weight: 600;
		color: var(--text-faint);
		user-select: none;
	}

	.group:first-child {
		margin-top: 0;
	}

	.list {
		display: flex;
		flex-direction: column;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.tab {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		height: 2rem;
		margin: 0.125rem 0;
		padding: 0 0.5rem;
		border: none;
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--text-muted);
		font-size: var(--gh-ui);
		line-height: var(--gh-lh-ui);
		font-weight: 600;
		text-align: left;
		text-decoration: none;
		cursor: pointer;
		transition:
			color var(--dur-fast) ease,
			background-color var(--dur-fast) ease;
	}

	.tab:hover {
		background: var(--fill-soft);
		color: var(--text-default);
	}

	.tab--on,
	.tab--on:hover {
		background: var(--accent-subtle);
		color: var(--accent);
	}

	.tab:focus-visible {
		outline: none;
		box-shadow: inset 0 0 0 2px var(--focus-ring-color);
	}

	.tab-label {
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.rail-foot {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		margin-top: auto;
		padding-top: 1rem;
	}

	.me {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 1rem 0.5rem 0;
		border-top: 1px dotted var(--settings-rule);
	}

	.me-face {
		--face: 1.75rem;
	}

	.me-text {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.me-name {
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		font-weight: 600;
		color: var(--gh-text);
	}

	.me-link {
		align-self: flex-start;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--gh-muted);
		text-decoration: underline;
		text-underline-offset: 0.2em;
	}

	.me-link:hover {
		color: var(--gh-text);
	}

	.me-link:focus-visible {
		outline: none;
		border-radius: var(--gh-r-control);
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.pane {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-width: 0;
		min-height: 0;
	}

	.head {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		padding: 1.5rem 3.5rem 1rem 1.5rem;
	}

	.pick {
		display: none;
		margin-bottom: 0.75rem;
	}

	.heading {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		min-width: 0;
	}

	.tile {
		display: inline-grid;
		place-items: center;
		flex: none;
		width: 2.25rem;
		height: 2.25rem;
		border-radius: var(--radius-md);
		background: var(--fill-soft);
		color: var(--text-default);
	}

	.tile--danger {
		background: color-mix(in srgb, var(--status-error) 10%, transparent);
		color: var(--status-error);
	}

	.heading-text {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		min-width: 0;
	}

	.title {
		margin: 0;
		font-size: var(--text-body);
		line-height: 1.5rem;
		font-weight: 600;
		color: var(--gh-text);
	}

	.subtitle {
		margin: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--gh-muted);
	}

	.close {
		position: absolute;
		top: 1rem;
		right: 1rem;
	}

	.body {
		flex: 1;
		min-height: 0;
		padding: 0 1.5rem 1.5rem;
		outline: none;
	}

	.section {
		display: flex;
		flex-direction: column;
	}

	.sub {
		margin: 1.5rem 0 0.5rem;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		font-weight: 600;
		color: var(--gh-muted);
	}

	.sub--danger {
		color: var(--status-error);
	}

	.foot {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		padding: 1rem 1.5rem 1.5rem;
	}

	@media (max-width: 720px) {
		.settings.ui-modal {
			height: calc(100dvh - 2rem);
		}

		.rail {
			display: none;
		}

		.pick {
			display: block;
		}
	}
</style>
