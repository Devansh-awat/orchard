<script lang="ts">
	import { Loader2, ExternalLink } from 'lucide-svelte';
	import { CircleX, Play, RefreshCw, Trash2, X } from '@jis3r/icons';
	import { motionStagger, motionPopover, motionBackdrop, cardTilt } from '$lib/utils/motion.svelte';
	import { portal } from '$lib/utils/format';
	import CircleAlertIcon from '$lib/components/icons/CircleAlertIcon.svelte';
	import TriangleAlertIcon from '$lib/components/icons/TriangleAlertIcon.svelte';

	let {
		deployment,
		projectBgImage,
		headerCollapsed,
		springCollapse,
		// Status
		deploymentStatusChip,
		sseDisconnected,
		// Notifications
		notificationSeverity,
		notificationLabel,
		notificationCount,
		notificationsOpen = $bindable(),
		notificationsRender = $bindable(),
		notifBtnEl = $bindable(),
		notifPanelPos,
		dismissedNotifications,
		noPodsReady,
		expandedWarningRaw,
		// Actions
		repoUrl,
		rebuilding,
		restarting,
		deleting,
		actionAnim,
		_isBuilding,
		onRebuild,
		onRestart,
		onShowDeleteModal,
		onTriggerActionAnim,
		// Notification actions
		onDismissNotification,
		onToggleWarningRaw,
		onViewBuildLogs,
		// Build info
		buildFailedNotifId,
		podWarningNotifId,
		humanizeWarning,
		sanitizeLogs,
		// Meta
		_commitLead,
		_commitLeadMono,
		_activeBuild,
		_buildFailed,
		branch,
	}: {
		deployment: any;
		projectBgImage: string | null;
		headerCollapsed: boolean;
		springCollapse: (collapsed: () => boolean) => (el: Element) => void;
		deploymentStatusChip: { label: string; tone: string };
		sseDisconnected: boolean;
		notificationSeverity: 'error' | 'warning' | null;
		notificationLabel: string;
		notificationCount: number;
		notificationsOpen: boolean;
		notificationsRender: boolean;
		notifBtnEl: HTMLButtonElement | undefined;
		notifPanelPos: { top: number; left: number };
		dismissedNotifications: Set<string>;
		noPodsReady: boolean;
		expandedWarningRaw: Set<string>;
		repoUrl: string | undefined;
		rebuilding: boolean;
		restarting: boolean;
		deleting: boolean;
		actionAnim: Record<string, boolean>;
		_isBuilding: boolean;
		onRebuild: () => void;
		onRestart: () => void;
		onShowDeleteModal: () => void;
		onTriggerActionAnim: (id: string) => void;
		onDismissNotification: (id: string) => void;
		onToggleWarningRaw: (id: string) => void;
		onViewBuildLogs: () => void;
		buildFailedNotifId: (d: any) => string;
		podWarningNotifId: (w: any) => string;
		humanizeWarning: (msg: string) => { title: string; hint: string; severity?: string; action?: string } | null;
		sanitizeLogs: (logs: string) => string;
		_commitLead: string | null;
		_commitLeadMono: boolean;
		_activeBuild: any;
		_buildFailed: boolean;
		branch: string | undefined;
	} = $props();
</script>

<section
	class="dep-header dep-header-card"
	class:dep-header-card--hasbg={!!projectBgImage}
	class:dep-header-card--collapsed={headerCollapsed}
	{@attach motionStagger({ index: 0, from: { y: 14, scale: 0.985 } })}
	{@attach cardTilt({ max: 2 })}
>
	{#if projectBgImage}
		<div class="dep-header-backdrop" aria-hidden="true">
			<div class="dep-header-bg dep-header-bg--1" style="background-image: url({JSON.stringify(projectBgImage)});"></div>
			<div class="dep-header-bg dep-header-bg--2" style="background-image: url({JSON.stringify(projectBgImage)});"></div>
			<div class="dep-header-bg dep-header-bg--3" style="background-image: url({JSON.stringify(projectBgImage)});"></div>
			<div class="dep-header-veil"></div>
		</div>
	{/if}
	<div class="dep-header-top">
		<div class="dep-header-identity">
			<h1 class="dep-header-name">{deployment.name}</h1>
			<span class="dep-status-chip dep-status-chip--{deploymentStatusChip.tone}">
				<span class="dep-status-dot"></span>
				{deploymentStatusChip.label}
			</span>
			{#if sseDisconnected}
				<span
					class="dep-status-chip dep-status-chip--warning"
					title="Live updates disconnected — values shown may be out of date. Reconnecting…"
				>
					<span class="dep-status-dot"></span>
					Live updates offline — data may be outdated
				</span>
			{/if}
		</div>
		<div class="dep-header-actions">
			{#if notificationSeverity}
				<div class="relative">
					<button
						bind:this={notifBtnEl}
						class="dep-alert-pill dep-alert-pill--{notificationSeverity}"
						onclick={() => notificationsOpen = !notificationsOpen}
						title="Open notifications"
					>
						{#if notificationSeverity === 'error'}
							<CircleAlertIcon size={14} animate={true} />
						{:else}
							<TriangleAlertIcon size={14} animate={true} />
						{/if}
						<span class="dep-alert-pill-label">{notificationLabel}</span>
						{#if notificationCount > 1}
							<span class="dep-alert-pill-count">{notificationCount}</span>
						{/if}
					</button>

					{#if notificationsRender}
						<!-- svelte-ignore a11y_click_events_have_key_events -->
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div class="notification-backdrop" use:portal onclick={() => notificationsOpen = false} {@attach motionBackdrop(() => !notificationsOpen, () => {})}></div>
						<div class="notification-panel" use:portal style="top: {notifPanelPos.top}px; left: {notifPanelPos.left}px; transform-origin: top right;" {@attach motionPopover({ closing: () => !notificationsOpen, onClosed: () => { notificationsRender = false; }, from: { y: -8, scale: 0.96, opacity: 0 } })}>
							<div class="flex items-center justify-between px-4 py-3" style="border-bottom: 1px solid var(--surface-border);">
								<p class="text-sm font-semibold" style="color: var(--center-channel-color);">Notifications</p>
								<button class="btn-icon rounded-md p-1" onclick={() => notificationsOpen = false}>
									<X size={14} />
								</button>
							</div>
							<div class="notification-scroll">
								{#if deployment.buildStatus === 'failed' && (deployment.buildError || deployment.buildLogs)}
									{@const _bfId = buildFailedNotifId(deployment)}
									{#if !dismissedNotifications.has(_bfId)}
										<div class="notification-item">
											<div class="flex items-start gap-3">
												<div class="notification-icon notification-icon-error">
													<CircleX size={16} class="h-4 w-4" />
												</div>
												<div class="flex-1 min-w-0">
													<p class="text-xs font-semibold" style="color: var(--error-text-color);">Build failed</p>
													{#if deployment.buildError}
														<p class="mt-1 text-xs font-mono truncate" style="color: var(--surface-muted);">{sanitizeLogs(deployment.buildError).split('\n')[0]}</p>
													{/if}
													{#if deployment.buildLogs}
														<button
															class="mt-1.5 text-[11px] font-medium hover:underline"
															style="color: var(--primary-color);"
															onclick={() => {
																notificationsOpen = false;
																onViewBuildLogs();
															}}
														>View build logs</button>
													{/if}
												</div>
												<button
													class="notification-dismiss"
													title="Dismiss"
													aria-label="Dismiss notification"
													onclick={() => onDismissNotification(_bfId)}
												>
													<X size={12} />
												</button>
											</div>
										</div>
									{/if}
								{/if}
								{#if deployment.warnings?.length}
									{#each deployment.warnings as warning}
										{@const _pwId = podWarningNotifId(warning)}
										{@const _h = humanizeWarning(warning.message)}
										{@const _rawOpen = expandedWarningRaw.has(_pwId)}
										{#if !dismissedNotifications.has(_pwId)}
											<div class="notification-item">
												<div class="flex items-start gap-3">
													<div class="notification-icon notification-icon-{noPodsReady ? 'error' : 'warning'}">
														{#if noPodsReady}
															<CircleAlertIcon size={16} animate={true} />
														{:else}
															<TriangleAlertIcon size={16} animate={true} />
														{/if}
													</div>
													<div class="flex-1 min-w-0">
														<p class="text-xs font-semibold" style="color: var({noPodsReady ? '--error-text-color' : '--warning-text'});">
															{noPodsReady ? 'Pod error' : 'Pod warning'}
														</p>
														<p class="mt-0.5 font-mono text-xs font-medium" style="color: var(--surface-muted);">{warning.podName}</p>
														{#if _h && !_rawOpen}
															<p class="mt-1 text-xs font-medium" style="color: var(--center-channel-color);">{_h.title}</p>
															<p class="mt-0.5 text-[11px]" style="color: var(--center-channel-color); opacity: 0.7;">{_h.hint}</p>
														{:else}
															<p class="mt-0.5 text-xs" style="color: var(--center-channel-color); opacity: 0.75; word-break: break-word;">{warning.message}</p>
														{/if}
														<div class="mt-1.5 flex items-center gap-2">
															{#if warning.timestamp}
																<span class="text-[10px]" style="color: var(--surface-muted);">{new Date(warning.timestamp).toLocaleTimeString()}</span>
															{/if}
															{#if _h}
																<button
																	class="warning-raw-toggle"
																	type="button"
																	onclick={() => onToggleWarningRaw(_pwId)}
																>{_rawOpen ? 'Hide original' : 'View original'}</button>
															{/if}
														</div>
													</div>
													<button
														class="notification-dismiss"
														title="Dismiss"
														aria-label="Dismiss notification"
														onclick={() => onDismissNotification(_pwId)}
													>
														<X size={12} />
													</button>
												</div>
											</div>
										{/if}
									{/each}
								{/if}
								{#if notificationCount === 0}
									<p class="notification-empty">No notifications</p>
								{/if}
							</div>
						</div>
					{/if}
				</div>
			{/if}
			{#if repoUrl}
				<button onclick={onRebuild} disabled={rebuilding || _isBuilding} class="btn btn-secondary btn-sm" onmouseenter={() => onTriggerActionAnim('redeploy')}>
					{#if rebuilding}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<RefreshCw size={14} animate={actionAnim.redeploy ?? false} />{/if}
					<span>Redeploy</span>
				</button>
			{/if}
			<button onclick={onRestart} disabled={restarting} class="btn btn-secondary btn-sm" onmouseenter={() => onTriggerActionAnim('restart')}>
				{#if restarting}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Play size={14} animate={actionAnim.restart ?? false} />{/if}
				<span>Restart</span>
			</button>
			<button onclick={onShowDeleteModal} disabled={deleting} class="btn btn-sm dep-delete-btn" onmouseenter={() => onTriggerActionAnim('delete')}>
				{#if deleting}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Trash2 size={14} animate={actionAnim.delete ?? false} />{/if}
			</button>
		</div>
	</div>

	<!-- Body: meta + domains. Spring-collapses when the user leaves Overview. -->
	<div class="dep-header-body" {@attach springCollapse(() => headerCollapsed)}>
		<p class="dep-header-meta">
			{#if _commitLead}
				{#if deployment.githubRepo && _activeBuild?.commitSha}
					<a
						href="{deployment.githubRepo.replace(/\.git$/, '')}/commit/{_activeBuild.commitSha}"
						target="_blank"
						rel="noopener noreferrer"
						class="dep-meta-lead dep-meta-lead-link"
						class:dep-meta-mono={_commitLeadMono}
					>{_commitLead}</a>
				{:else}
					<span class="dep-meta-lead" class:dep-meta-mono={_commitLeadMono}>{_commitLead}</span>
				{/if}
			{/if}
			{#if deployment.githubRepo}
				{#if _commitLead}<span class="dep-meta-dot">·</span>{/if}
				<a href={deployment.githubRepo.replace(/\.git$/, '')} target="_blank" rel="noopener noreferrer" class="dep-meta-link">
					{deployment.githubRepo.replace('https://github.com/', '').replace(/\.git$/, '')}
				</a>
			{/if}
			{#if _activeBuild?.branch || branch}
				{#if deployment.githubRepo}<span class="dep-meta-dot">·</span>{/if}
				<span class="dep-meta-mono">{_activeBuild?.branch || branch}</span>
			{/if}
			{#if _activeBuild}
				<span class="dep-meta-dot">·</span>
				<span>{(() => {
					const diff = Date.now() - new Date(_activeBuild.createdAt).getTime();
					const mins = Math.floor(diff / 60000);
					if (mins < 1) return 'just now';
					if (mins < 60) return `${mins}m ago`;
					const hrs = Math.floor(mins / 60);
					if (hrs < 24) return `${hrs}h ago`;
					const days = Math.floor(hrs / 24);
					if (days < 30) return `${days}d ago`;
					return new Date(_activeBuild.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
				})()}</span>
				{#if _activeBuild.triggerType === 'manual' && _activeBuild.triggeredBy}
					<span>by</span>
					<span class="dep-meta-strong">@{_activeBuild.triggeredBy.username}</span>
				{:else if _activeBuild.triggerType === 'auto'}
					<span>via GitHub</span>
				{/if}
			{/if}
			{#if _buildFailed && (deployment.buildLogs || deployment.buildError)}
				<span class="dep-meta-dot">·</span>
				<button
					class="dep-meta-link dep-meta-button"
					onclick={onViewBuildLogs}
				>View build logs</button>
			{/if}
		</p>

		{#if deployment.ingresses?.length}
			<div class="dep-header-divider" aria-hidden="true"></div>
			<div class="dep-header-domains">
				{#each deployment.ingresses.slice(0, 4) as ingress}
					<a
						href="{ingress.tlsEnabled ? 'https' : 'http'}://{ingress.host}{ingress.path}"
						target="_blank"
						rel="noopener noreferrer"
						class="dep-meta-domain"
					>
						{ingress.host}
						<ExternalLink class="dep-meta-domain-icon h-3 w-3" />
					</a>
				{/each}
			</div>
		{/if}
	</div>
</section>
