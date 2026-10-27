<script lang="ts">
	import { browser } from '$app/environment';
	import { onDestroy, onMount, type Snippet } from 'svelte';
	import { ChevronLeft, ChevronRight, KeyRound, Lock, Mail, Check, Sprout } from 'lucide-svelte';
	import { Alert, Button, CodeInput, Field, Input, Skeleton } from '$lib/components/ui';
	import List from '$lib/components/ui/List.svelte';
	import ListRow from '$lib/components/ui/ListRow.svelte';
	import Turnstile from '$lib/components/Turnstile.svelte';
	import { apiBase, apiFetch, authConfig } from '$lib/stores';
	import type { User } from '$lib/stores';
	import {
		FADE,
		decorativeMotion,
		springTiming,
		fade as fadeTiming
	} from '$lib/utils/motion.svelte';
	import { fade } from '$lib/utils/transitions';
	import ProviderIcon, { hasProviderMark } from './ProviderIcon.svelte';
	import { signingIn } from './signing-in';
	import type { LoginProvider } from './types';

	type Step = 'start' | 'choose' | 'passkey' | 'password' | 'code' | 'blocked' | 'done';
	type EmailAccess = 'open' | 'tucked' | 'none' | 'loading';

	let {
		title,
		subtitle = undefined,
		mark = undefined,
		providers = [],
		providersLoaded = true,
		emailAccess = 'open',
		revealLabel = 'Sign in with email instead',
		policy = undefined,
		returnTo = undefined,
		error = null,
		email = $bindable(''),
		initialCode = '',
		bloom = $bindable(false),
		landed = $bindable(false),
		aside = undefined,
		onAuthenticated,
		onSsoRedirect = undefined
	}: {
		title: string;
		subtitle?: string | Snippet;
		mark?: Snippet;
		providers?: LoginProvider[];
		providersLoaded?: boolean;
		emailAccess?: EmailAccess;
		revealLabel?: string;
		policy?: string;
		returnTo?: string;
		error?: string | null;
		email?: string;
		initialCode?: string;
		bloom?: boolean;
		landed?: boolean;
		aside?: Snippet;
		onAuthenticated: (message: string, user: User | undefined, landing: Promise<void>) => unknown;
		onSsoRedirect?: (email: string) => Promise<boolean>;
	} = $props();

	const ORDER: Step[] = ['start', 'choose', 'passkey', 'password', 'code', 'blocked', 'done'];
	const LANDING_MS = 620;

	let step = $state<Step>('start');
	let forward = true;
	let revealed = $state(false);
	let code = $state('');
	let password = $state('');
	let fault = $state<string | null>(null);
	let codeFault = $state(false);
	let busy = $state<null | 'check' | 'send' | 'verify' | 'passkey' | 'provider'>(null);
	let starting = $state<string | null>(null);
	let resent = $state(false);
	let blocked = $state<'private_beta' | 'signups_disabled' | null>(null);
	let passkeySupported = $state(false);
	let hasPassword = $state(false);
	let hasPasskey = $state(false);
	let chooser = $state(false);
	let siteKey = $state<string | null>(null);
	let widget = $state<{ execute: () => Promise<string> } | null>(null);
	let configLoaded = false;
	let pendingAutoVerify = false;

	const emailOpen = $derived(emailAccess === 'open' || revealed);
	const address = $derived(email.trim().toLowerCase());

	function go(next: Step) {
		forward = ORDER.indexOf(next) >= ORDER.indexOf(step);
		fault = null;
		codeFault = false;
		step = next;
	}

	onMount(() => {
		passkeySupported =
			browser && window.isSecureContext && typeof window.PublicKeyCredential !== 'undefined';
		authConfig
			.load()
			.then((config) => (siteKey = config.turnstileSiteKey))
			.catch(() => (siteKey = null))
			.finally(() => {
				configLoaded = true;
				maybeAutoVerify();
			});
		if (initialCode && email) {
			code = initialCode;
			go('code');
			pendingAutoVerify = true;
			maybeAutoVerify();
		}
	});

	function maybeAutoVerify() {
		if (!pendingAutoVerify || !configLoaded) return;
		pendingAutoVerify = false;
		verifyCode();
	}

	async function botHeaders(): Promise<Record<string, string>> {
		if (!siteKey || !widget) return {};
		return { 'x-turnstile-token': await widget.execute() };
	}

	function blockedBy(status: number, data: { message?: string }) {
		if (status !== 403) return false;
		if (data?.message !== 'private_beta' && data?.message !== 'signups_disabled') return false;
		blocked = data.message;
		go('blocked');
		return true;
	}

	onDestroy(() => signingIn.set(false));

	async function land(message: string, user?: User) {
		go('done');
		bloom = true;
		landed = true;
		signingIn.set(true);
		const landing = new Promise<void>((resolve) =>
			setTimeout(resolve, decorativeMotion() ? LANDING_MS : 0)
		);
		try {
			await onAuthenticated(message, user, landing);
		} catch {
			signingIn.set(false);
			bloom = false;
			landed = false;
			go('start');
			fault = 'Signed in, but loading your account failed. Try again.';
		}
	}

	function startProvider(provider: LoginProvider) {
		starting = provider.id;
		const url = new URL(`${$apiBase}${provider.startUrl}`, window.location.origin);
		if (returnTo && provider.startUrl.includes('/sso/start/')) {
			url.searchParams.set('returnTo', returnTo);
		}
		window.location.href = url.toString();
	}

	async function sendCode(again = false) {
		if (busy === 'send') return;
		if (!address) {
			fault = 'Enter the email address you use with Orchard.';
			return;
		}
		busy = 'send';
		fault = null;
		try {
			const response = await apiFetch('/apiv1/auth/otp/request', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', ...(await botHeaders()) },
				body: JSON.stringify({ email: address })
			});
			const data = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(data?.message || 'Could not send the code.');
			code = '';
			if (again) {
				resent = true;
				setTimeout(() => (resent = false), 4000);
			} else {
				go('code');
			}
		} catch (err) {
			fault = err instanceof Error ? err.message : 'Could not send the code.';
		} finally {
			busy = null;
		}
	}

	async function continueWithEmail() {
		if (busy) return;
		if (!address || !address.includes('@')) {
			fault = 'Enter the email address you use with Orchard.';
			return;
		}
		busy = 'check';
		fault = null;
		try {
			if (onSsoRedirect && (await onSsoRedirect(address))) return;
			let methods = { passkey: false, password: false, superadmin: false };
			try {
				const response = await apiFetch(`/apiv1/auth/methods?email=${encodeURIComponent(address)}`);
				const data = await response.json().catch(() => ({}));
				methods = {
					passkey: Boolean(data?.passkey),
					password: Boolean(data?.password),
					superadmin: Boolean(data?.superadmin)
				};
			} catch {
				methods = { passkey: false, password: false, superadmin: false };
			}
			hasPassword = methods.password;
			hasPasskey = methods.passkey && passkeySupported;
			chooser = methods.superadmin && (hasPasskey || hasPassword);
			busy = null;
			if (chooser) go('choose');
			else if (hasPasskey) {
				go('passkey');
				await signInWithPasskey();
			} else if (hasPassword) go('password');
			else await sendCode();
		} finally {
			if (busy === 'check') busy = null;
		}
	}

	async function verifyCode() {
		if (busy === 'verify') return;
		if (code.length !== 6) {
			codeFault = true;
			fault = 'Enter all 6 digits.';
			return;
		}
		busy = 'verify';
		fault = null;
		codeFault = false;
		try {
			const response = await apiFetch('/apiv1/auth/otp/verify', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', ...(await botHeaders()) },
				body: JSON.stringify({ email: address, code })
			});
			const data = await response.json().catch(() => ({}));
			if (!response.ok) {
				if (blockedBy(response.status, data)) return;
				throw new Error(data?.message || 'That code is wrong or expired.');
			}
			busy = null;
			await land('Signed in with your email', data?.user);
		} catch (err) {
			codeFault = true;
			fault = err instanceof Error ? err.message : 'That code is wrong or expired.';
		} finally {
			if (busy === 'verify') busy = null;
		}
	}

	async function signInWithPassword() {
		if (busy === 'verify') return;
		if (!password) {
			fault = 'Enter your password.';
			return;
		}
		busy = 'verify';
		fault = null;
		try {
			const response = await apiFetch('/apiv1/auth/password', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', ...(await botHeaders()) },
				body: JSON.stringify({ email: address, password })
			});
			const data = await response.json().catch(() => ({}));
			if (!response.ok) {
				if (blockedBy(response.status, data)) return;
				throw new Error(data?.message || 'That password is not right.');
			}
			password = '';
			busy = null;
			await land('Signed in', data?.user);
		} catch (err) {
			fault = err instanceof Error ? err.message : 'Could not sign in.';
		} finally {
			if (busy === 'verify') busy = null;
		}
	}

	async function signInWithPasskey() {
		if (busy === 'passkey') return;
		if (!passkeySupported) {
			fault = 'This browser does not support passkeys.';
			return;
		}
		busy = 'passkey';
		fault = null;
		try {
			const response = await apiFetch('/apiv1/auth/passkey/authenticate/options', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email: address || undefined })
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data?.message || 'Could not start passkey sign-in.');
			}
			const options = await response.json();
			const { startAuthentication } = await import('@simplewebauthn/browser');
			const credential = await startAuthentication({ optionsJSON: options });
			const verify = await apiFetch('/apiv1/auth/passkey/authenticate/verify', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ response: credential })
			});
			const data = await verify.json().catch(() => ({}));
			if (!verify.ok) {
				if (blockedBy(verify.status, data)) return;
				throw new Error(data?.message || 'Passkey sign-in failed.');
			}
			busy = null;
			await land('Signed in with your passkey', data?.user);
		} catch (err) {
			fault =
				err instanceof Error && err.name === 'NotAllowedError'
					? 'Passkey request was cancelled.'
					: err instanceof Error
						? err.message
						: 'Passkey sign-in failed.';
		} finally {
			if (busy === 'passkey') busy = null;
		}
	}

	function back() {
		password = '';
		code = '';
		if (chooser && step !== 'choose') go('choose');
		else go('start');
	}

	function enter(el: HTMLElement) {
		if (!decorativeMotion()) return;
		const dx = forward ? 14 : -14;
		el.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], springTiming('snap'));
		el.animate([{ opacity: 0 }, { opacity: 1 }], { ...fadeTiming('in', 0.04), fill: 'backwards' });
	}
</script>

{#snippet botCheck()}
	{#if siteKey}<Turnstile bind:this={widget} {siteKey} action="signin" />{/if}
{/snippet}

{#snippet head(heading: string, sub: string | Snippet | undefined, withBack: boolean)}
	<header class="head">
		{#if withBack}
			<div class="lead">
				<Button variant="ghost" size="sm" icon={ChevronLeft} class="back" onclick={back}
					>Back</Button
				>
			</div>
		{:else if mark}
			<div class="lead">{@render mark()}</div>
		{/if}
		<h1 class="title">{heading}</h1>
		{#if sub}
			<p class="sub">
				{#if typeof sub === 'string'}{sub}{:else}{@render sub()}{/if}
			</p>
		{/if}
	</header>
{/snippet}

{#snippet who()}
	<span class="who">{address}</span>
{/snippet}

{#snippet faultLine()}
	{#if fault}<p class="fault" role="alert">{fault}</p>{/if}
{/snippet}

<div class="steps">
	{#key step}
		<div class="step" {@attach enter} out:fade={{ duration: FADE.out }}>
			{#if step === 'start'}
				{@render head(title, subtitle, false)}
				{#if error}<Alert tone="error">{error}</Alert>{/if}
				{#if providers.length}
					<div class="stack">
						{#each providers as provider, i (provider.id)}
							<Button
								variant={i === 0 ? 'primary' : 'secondary'}
								size="lg"
								class="wide"
								loading={starting === provider.id}
								onclick={() => startProvider(provider)}
							>
								{#if starting !== provider.id && hasProviderMark(provider.preset, provider.iconUrl)}
									<ProviderIcon preset={provider.preset} iconUrl={provider.iconUrl} size={18} />
								{/if}
								{provider.label}
							</Button>
						{/each}
					</div>
				{:else if !providersLoaded}
					<Skeleton height="2.5rem" />
				{/if}
				{#if (providers.length || !providersLoaded) && emailAccess !== 'none'}
					<div class="or"><span>or</span></div>
				{/if}
				{#if emailAccess === 'loading'}
					<Skeleton height="2.5rem" />
				{:else if emailOpen}
					<form
						class="stack"
						novalidate
						onsubmit={(e) => {
							e.preventDefault();
							continueWithEmail();
						}}
					>
						<Field label="Email" for="signin-email" error={fault}>
							<Input
								id="signin-email"
								type="email"
								name="email"
								size="lg"
								placeholder="you@example.com"
								autocomplete="email webauthn"
								autofocus={revealed}
								error={!!fault}
								bind:value={email}
								oninput={() => (fault = null)}
							/>
						</Field>
						{@render botCheck()}
						<Button
							type="submit"
							size="lg"
							variant={providers.length ? 'secondary' : 'primary'}
							class="wide"
							loading={busy === 'check' || busy === 'send'}
						>
							Continue
						</Button>
					</form>
				{:else if emailAccess === 'tucked'}
					<Button variant="ghost" size="lg" class="wide" onclick={() => (revealed = true)}>
						{revealLabel}
					</Button>
				{/if}
				{#if policy && !emailOpen}<p class="note">{policy}</p>{/if}
			{:else if step === 'choose'}
				{@render head('Choose how to sign in', who, true)}
				<List label="Sign-in methods">
					{#if hasPasskey}
						<ListRow
							title="Passkey"
							subtitle="Touch ID, Windows Hello or a security key"
							onclick={() => {
								go('passkey');
								signInWithPasskey();
							}}
						>
							{#snippet leading()}<span class="glyph"><KeyRound size={16} /></span>{/snippet}
							{#snippet trailing()}<ChevronRight size={16} class="chev" />{/snippet}
						</ListRow>
					{/if}
					{#if hasPassword}
						<ListRow title="Password" onclick={() => go('password')}>
							{#snippet leading()}<span class="glyph"><Lock size={16} /></span>{/snippet}
							{#snippet trailing()}<ChevronRight size={16} class="chev" />{/snippet}
						</ListRow>
					{/if}
					<ListRow
						title="Email me a code"
						subtitle="A 6-digit code, valid for 10 minutes"
						onclick={() => sendCode()}
					>
						{#snippet leading()}<span class="glyph"><Mail size={16} /></span>{/snippet}
						{#snippet trailing()}<ChevronRight size={16} class="chev" />{/snippet}
					</ListRow>
				</List>
				{@render faultLine()}
				{@render botCheck()}
			{:else if step === 'passkey'}
				{@render head('Use your passkey', who, true)}
				<Button
					variant="primary"
					size="lg"
					class="wide"
					icon={KeyRound}
					loading={busy === 'passkey'}
					onclick={signInWithPasskey}
				>
					Sign in with passkey
				</Button>
				{@render faultLine()}
				{@render botCheck()}
				<div class="alts">
					{#if hasPassword}
						<Button variant="ghost" size="sm" onclick={() => go('password')}>Use password</Button>
					{/if}
					<Button variant="ghost" size="sm" loading={busy === 'send'} onclick={() => sendCode()}>
						Email me a code
					</Button>
				</div>
			{:else if step === 'password'}
				{@render head('Enter your password', who, true)}
				<form
					class="stack"
					novalidate
					onsubmit={(e) => {
						e.preventDefault();
						signInWithPassword();
					}}
				>
					<input
						type="email"
						class="hidden-user"
						autocomplete="username"
						value={address}
						readonly
						tabindex="-1"
						aria-hidden="true"
					/>
					<Field label="Password" for="signin-password" error={fault}>
						<Input
							id="signin-password"
							type="password"
							name="password"
							size="lg"
							autocomplete="current-password"
							autofocus
							error={!!fault}
							bind:value={password}
							oninput={() => (fault = null)}
						/>
					</Field>
					{@render botCheck()}
					<Button
						type="submit"
						variant="primary"
						size="lg"
						class="wide"
						loading={busy === 'verify'}
					>
						Sign in
					</Button>
				</form>
				<div class="alts">
					{#if hasPasskey}
						<Button variant="ghost" size="sm" onclick={() => go('passkey')}>Use passkey</Button>
					{/if}
					<Button variant="ghost" size="sm" loading={busy === 'send'} onclick={() => sendCode()}>
						Email me a code
					</Button>
				</div>
			{:else if step === 'code'}
				{#snippet sentTo()}Enter the code we sent to <span class="who">{address}</span>{/snippet}
				{@render head('Check your email', sentTo, true)}
				<form
					class="stack"
					novalidate
					onsubmit={(e) => {
						e.preventDefault();
						verifyCode();
					}}
				>
					<CodeInput
						id="signin-code"
						bind:value={code}
						error={codeFault}
						autofocus
						disabled={busy === 'verify'}
						oncomplete={() => verifyCode()}
					/>
					{@render faultLine()}
					{@render botCheck()}
					<Button
						type="submit"
						variant="primary"
						size="lg"
						class="wide"
						disabled={code.length < 6}
						loading={busy === 'verify'}
					>
						Continue
					</Button>
				</form>
				<div class="alts">
					<Button
						variant="ghost"
						size="sm"
						loading={busy === 'send'}
						disabled={resent}
						onclick={() => sendCode(true)}
					>
						{resent ? 'New code sent' : 'Send a new code'}
					</Button>
				</div>
			{:else if step === 'blocked'}
				<header class="head">
					<div class="lead"><span class="badge"><Sprout size={18} /></span></div>
					<h1 class="title">
						{blocked === 'signups_disabled' ? 'Sign-ups are closed' : 'Orchard is invite-only'}
					</h1>
					<p class="sub">
						{blocked === 'signups_disabled'
							? 'This instance is not taking new accounts. Ask an administrator to add you.'
							: 'Ask someone in an organization on this instance to invite you, then sign in with the email they used.'}
					</p>
				</header>
				<Button variant="secondary" size="lg" class="wide" onclick={() => go('start')}>
					Back to sign in
				</Button>
			{:else}
				<header class="head head--done">
					<div class="lead">
						<span class="badge badge--done"><Check size={18} strokeWidth={2.5} /></span>
					</div>
					<h1 class="title">You're in</h1>
					<p class="sub">Opening Orchard</p>
				</header>
			{/if}
			{#if aside && step !== 'done' && step !== 'blocked'}
				<div class="aside">{@render aside()}</div>
			{/if}
		</div>
	{/key}
</div>

<style>
	.steps {
		display: grid;
	}
	.step {
		grid-area: 1 / 1;
		display: flex;
		flex-direction: column;
		gap: 1rem;
		min-width: 0;
	}
	.head {
		display: flex;
		flex-direction: column;
		margin-bottom: 0.5rem;
	}
	.lead {
		display: flex;
		align-items: center;
		height: 2.5rem;
		margin-bottom: 1.25rem;
	}
	.lead :global(.back) {
		margin-left: -0.5rem;
	}
	.title {
		margin: 0;
		font-size: var(--text-title-2);
		line-height: var(--lh-title-2);
		font-weight: var(--weight-semibold);
		letter-spacing: -0.015em;
		text-wrap: balance;
	}
	.sub {
		margin: 0.25rem 0 0;
		font-size: var(--text-body);
		line-height: var(--lh-body);
		color: var(--text-muted);
		text-wrap: pretty;
		overflow-wrap: anywhere;
	}
	.who {
		color: var(--text-default);
		font-weight: var(--weight-medium);
	}
	.stack {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.stack :global(.wide),
	.step > :global(.wide) {
		width: 100%;
	}
	.or {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-faint);
	}
	.or::before,
	.or::after {
		content: '';
		flex: 1;
		height: 0.5px;
		background: var(--rule-strong);
	}
	.note {
		margin: 0;
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		color: var(--text-muted);
		text-align: center;
	}
	.fault {
		margin: 0;
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		color: var(--status-error);
	}
	.alts {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 0.25rem;
		margin-top: -0.25rem;
	}
	.glyph {
		display: grid;
		place-items: center;
		width: 2rem;
		height: 2rem;
		border-radius: calc(0.5rem * var(--corner-scale));
		corner-shape: var(--corner);
		background: color-mix(in oklab, var(--accent-solid) 12%, transparent);
		color: var(--accent-9);
	}
	.step :global(.chev) {
		color: var(--text-faint);
	}
	.badge {
		display: grid;
		place-items: center;
		width: 2.5rem;
		height: 2.5rem;
		border-radius: calc(0.75rem * var(--corner-scale));
		corner-shape: var(--corner);
		background: color-mix(in oklab, var(--accent-solid) 12%, transparent);
		color: var(--accent-9);
	}
	.badge--done {
		background: var(--green-solid);
		color: var(--on-solid);
		animation: badge-in var(--spring-bouncy-duration) var(--spring-bouncy);
	}
	.head--done {
		align-items: center;
		margin-bottom: 0;
		text-align: center;
	}
	.head--done .lead {
		margin-bottom: 1rem;
	}
	.aside {
		display: flex;
		justify-content: center;
	}
	.hidden-user {
		position: absolute;
		width: 1px;
		height: 1px;
		opacity: 0;
		pointer-events: none;
	}
	@keyframes badge-in {
		from {
			transform: scale(0.4);
			opacity: 0;
		}
	}
</style>
