<script lang="ts">
	import { Users, Loader2, Trash2, ChevronDown, Check } from 'lucide-svelte';
	import { motionStagger, motionPopover } from '$lib/utils/motion.svelte';
	import type { ProjectMember, OrgMember } from './types';
	import { ROLE_OPTIONS } from './types';

	let {
		projectMembers,
		canManageMembers = false,
		canEdit = false,
		memberSearch = $bindable(''),
		filteredOrgMembers,
		addingMember = false,
		removingMemberId = null as string | null,
		updatingMemberId = null as string | null,
		openRoleMenuId = $bindable<string | null>(null),
		onAddMember,
		onUpdateMemberRole,
		onRemoveMember,
		onEnsureOrgMembersLoaded,
	}: {
		projectMembers: ProjectMember[];
		canManageMembers?: boolean;
		canEdit?: boolean;
		memberSearch?: string;
		filteredOrgMembers: OrgMember[];
		addingMember?: boolean;
		removingMemberId?: string | null;
		updatingMemberId?: string | null;
		openRoleMenuId?: string | null;
		onAddMember: (email: string) => void;
		onUpdateMemberRole: (memberId: string, role: string, prevRole: string) => void;
		onRemoveMember: (memberId: string) => void;
		onEnsureOrgMembersLoaded: () => void;
	} = $props();

	let pickerOpen = $state(false);
	let pickerRender = $state(false);
	let renderRoleMenuId = $state<string | null>(null);

	$effect(() => {
		if (pickerOpen) pickerRender = true;
	});
	$effect(() => {
		if (openRoleMenuId !== null) renderRoleMenuId = openRoleMenuId;
	});

	// Portal an element to <body> and pin it under a reference element
	function portalUnder(getAnchor: () => Element | null | undefined, offset = 6) {
		return (el: Element) => {
			const node = el as HTMLElement;
			const place = () => {
				const anchor = getAnchor();
				if (!anchor) return;
				const r = anchor.getBoundingClientRect();
				node.style.position = 'fixed';
				node.style.top = `${r.bottom + offset}px`;
				node.style.right = `${window.innerWidth - r.right}px`;
				node.style.left = 'auto';
				node.style.zIndex = '9999';
			};
			place();
			document.body.appendChild(node);
			const onResize = () => place();
			window.addEventListener('resize', onResize);
			window.addEventListener('scroll', onResize, true);
			return () => {
				window.removeEventListener('resize', onResize);
				window.removeEventListener('scroll', onResize, true);
				try { node.remove(); } catch { /* already removed */ }
			};
		};
	}
</script>

<svelte:window onclick={() => (openRoleMenuId = null)} onkeydown={(e) => { if (e.key === 'Escape') openRoleMenuId = null; }} />

<div class="pj-members-section">
	<div class="pj-members-card">
		<div class="pj-members-head">
			<div class="pj-members-title">
				<Users size={16} />
				<span>Members</span>
				<span class="pj-members-count">{projectMembers.length}</span>
			</div>
			{#if canManageMembers}
			<div class="pj-picker">
				<input
					type="text"
					bind:value={memberSearch}
					placeholder="Add a member…"
					class="pj-invite-input"
					onfocus={() => { pickerOpen = true; onEnsureOrgMembersLoaded(); }}
					onblur={() => setTimeout(() => (pickerOpen = false), 150)}
				/>
				{#if pickerRender && filteredOrgMembers.length > 0}
					<div
						class="pj-picker-dropdown"
						{@attach motionPopover({
							from: { y: -8, scale: 0.96 },
							closing: () => !pickerOpen,
							onClosed: () => { pickerRender = false; }
						})}
					>
						{#each filteredOrgMembers as om (om.id)}
							<button
								type="button"
								class="pj-picker-item"
								onmousedown={(e) => e.preventDefault()}
								onclick={() => onAddMember(om.user.email)}
								disabled={addingMember}
							>
								{#if om.user.imageUrl}
									<img src={om.user.imageUrl} alt="" class="pj-member-avatar" />
								{:else}
									<div class="pj-member-avatar pj-member-avatar--letter">
										{(om.user.firstName ?? om.user.email).charAt(0).toUpperCase()}
									</div>
								{/if}
								<div class="pj-member-info">
									<span class="pj-member-name">
										{#if om.user.firstName}{om.user.firstName}{#if om.user.lastName}&nbsp;{om.user.lastName}{/if}{:else}{om.user.email}{/if}
										{#if om.role === 'guest'}
											<span class="guest-pill" title="Guests only see projects they're explicit members of">Guest</span>
										{/if}
									</span>
									{#if om.user.firstName}
										<span class="pj-member-email">{om.user.email}</span>
									{/if}
								</div>
							</button>
						{/each}
					</div>
				{:else if pickerRender && memberSearch.trim() && filteredOrgMembers.length === 0}
					<div
						class="pj-picker-dropdown"
						{@attach motionPopover({
							from: { y: -8, scale: 0.96 },
							closing: () => !pickerOpen,
							onClosed: () => { pickerRender = false; }
						})}
					>
						<div class="pj-picker-empty">No matching org members</div>
					</div>
				{/if}
			</div>
			{/if}
		</div>

		{#if projectMembers.length > 0}
			<ul class="pj-members-list">
				{#each projectMembers as m, i (m.id)}
					<li
						class="pj-member"
						{@attach motionStagger({ index: i, axis: 'x', from: { y: -10, scale: 1 }, stride: 0.04 })}
					>
						{#if m.user.imageUrl}
							<img src={m.user.imageUrl} alt="" class="pj-member-avatar" />
						{:else}
							<div class="pj-member-avatar pj-member-avatar--letter">
								{(m.user.firstName ?? m.user.email).charAt(0).toUpperCase()}
							</div>
						{/if}
						<div class="pj-member-info">
							<span class="pj-member-name">
								{#if m.user.firstName}{m.user.firstName}{#if m.user.lastName}&nbsp;{m.user.lastName}{/if}{:else}{m.user.email}{/if}
								{#if m.orgRole === 'guest'}
									<span class="guest-pill" title="Guests are only members of specific projects, not the whole organization">Guest</span>
								{/if}
							</span>
							<span class="pj-member-email">{m.user.email}</span>
						</div>
						{#if canManageMembers}
							{@const triggerId = `pj-role-trigger-${m.id}`}
							<div class="pj-role-wrap">
								<button
									type="button"
									id={triggerId}
									class="pj-role-chip pj-role-chip--{m.role.name} pj-role-trigger"
									aria-haspopup="listbox"
									aria-expanded={openRoleMenuId === m.id}
									aria-label="Change role for {m.user.firstName ?? m.user.email}"
									disabled={updatingMemberId === m.id}
									onclick={(e) => {
										e.stopPropagation();
										openRoleMenuId = openRoleMenuId === m.id ? null : m.id;
									}}
								>
									{#if updatingMemberId === m.id}
										<Loader2 class="h-3 w-3 animate-spin" />
									{:else}
										<span>{m.role.name}</span>
										<ChevronDown class="h-3 w-3 pj-role-caret" />
									{/if}
								</button>
								{#if renderRoleMenuId === m.id}
									<div
										class="pj-role-menu"
										role="listbox"
										onclick={(e) => e.stopPropagation()}
										{@attach motionPopover({
											from: { y: -6, scale: 0.9 },
											stiffness: 540,
											damping: 30,
											closing: () => openRoleMenuId !== m.id,
											onClosed: () => { if (renderRoleMenuId === m.id) renderRoleMenuId = null; }
										})}
										{@attach portalUnder(() => document.getElementById(triggerId))}
									>
										{#each ROLE_OPTIONS as opt}
											<button
												type="button"
												role="option"
												class="pj-role-option"
												class:is-selected={m.role.name === opt.value}
												aria-selected={m.role.name === opt.value}
												onclick={() => {
													openRoleMenuId = null;
													onUpdateMemberRole(m.id, opt.value, m.role.name);
												}}
											>
												<span class="pj-role-option-check">
													{#if m.role.name === opt.value}
														<Check class="h-3.5 w-3.5" />
													{/if}
												</span>
												<span class="pj-role-option-text">
													<span class="pj-role-option-label">
														<span class="pj-role-dot pj-role-dot--{opt.value}"></span>
														{opt.label}
													</span>
													<span class="pj-role-option-desc">{opt.desc}</span>
												</span>
											</button>
										{/each}
									</div>
								{/if}
							</div>
						{:else}
							<span class="pj-role-chip pj-role-chip--{m.role.name}">{m.role.name}</span>
						{/if}
						{#if canEdit}
						<button
							class="pj-member-remove"
							title="Remove member"
							aria-label="Remove {m.user.firstName ?? m.user.email}"
							onclick={() => onRemoveMember(m.id)}
							disabled={removingMemberId === m.id}
						>
							{#if removingMemberId === m.id}
								<Loader2 class="h-3.5 w-3.5 animate-spin" />
							{:else}
								<Trash2 class="h-3.5 w-3.5" />
							{/if}
						</button>
						{/if}
					</li>
				{/each}
			</ul>
		{:else}
			<div class="pj-members-empty">No members yet. Add someone from your organization above.</div>
		{/if}
	</div>
</div>
