<script lang="ts">
	import { ArrowLeft } from 'lucide-svelte';
	import { Button } from '$lib/components/ui';

	interface Props {
		status?: number;
		message?: string;
	}

	let { status = 404, message = '' }: Props = $props();

	const defaultMessages: Record<number, string> = {
		400: 'The request was invalid.',
		401: 'You need to sign in to view this page.',
		403: "You don't have access to this page.",
		404: "The page you're looking for doesn't exist.",
		408: 'The request took too long.',
		429: 'Too many requests. Try again in a moment.',
		500: 'Something went wrong on our end.',
		502: 'The server is temporarily unavailable.',
		503: 'The service is temporarily unavailable.',
		504: 'The server took too long to respond.'
	};

	const displayMessage = $derived(message || defaultMessages[status] || 'Something went wrong.');
</script>

<div class="nf-page">
	<div class="nf-bg">
		<div class="nf-orb nf-orb-1"></div>
		<div class="nf-orb nf-orb-2"></div>
		<div class="nf-orb nf-orb-3"></div>
		<div class="nf-grid-overlay"></div>
	</div>

	<div class="nf-card">
		<img
			src="https://http.cat/{status}"
			alt={String(status)}
			class="nf-cat"
			onerror={(e: Event) => {
				(e.currentTarget as HTMLImageElement).style.display = 'none';
			}}
		/>
		<h1 class="nf-title">{displayMessage}</h1>
		<Button variant="primary" href="/">
			<ArrowLeft size={16} />
			Back to dashboard
		</Button>
	</div>
</div>

<style>
	.nf-page {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 100vh;
		position: relative;
		overflow: hidden;
		background: var(--center-channel-bg);
	}

	.nf-bg {
		position: absolute;
		inset: 0;
		z-index: 0;
		overflow: hidden;
	}

	.nf-grid-overlay {
		position: absolute;
		inset: 0;
		background-image:
			linear-gradient(var(--surface-border) 1px, transparent 1px),
			linear-gradient(90deg, var(--surface-border) 1px, transparent 1px);
		background-size: 60px 60px;
		opacity: 0.4;
		mask-image: radial-gradient(ellipse 80% 60% at 50% 50%, black 20%, transparent 100%);
		-webkit-mask-image: radial-gradient(ellipse 80% 60% at 50% 50%, black 20%, transparent 100%);
	}

	.nf-orb {
		position: absolute;
		border-radius: 50%;
		filter: blur(80px);
		opacity: 0.35;
		will-change: transform;
	}

	.nf-orb-1 {
		width: 420px;
		height: 420px;
		background: var(--button-bg);
		top: -12%;
		right: -8%;
		animation: nf-float-1 18s ease-in-out infinite;
	}

	.nf-orb-2 {
		width: 350px;
		height: 350px;
		background: color-mix(in srgb, var(--button-bg) 50%, #818cf8);
		bottom: -8%;
		left: -5%;
		animation: nf-float-2 22s ease-in-out infinite;
	}

	.nf-orb-3 {
		width: 250px;
		height: 250px;
		background: color-mix(in srgb, var(--button-bg) 40%, var(--online-indicator));
		top: 40%;
		left: 50%;
		animation: nf-float-3 15s ease-in-out infinite;
	}

	@keyframes nf-float-1 {
		0%,
		100% {
			transform: translate(0, 0) scale(1);
		}
		33% {
			transform: translate(-40px, 30px) scale(1.08);
		}
		66% {
			transform: translate(20px, -50px) scale(0.95);
		}
	}
	@keyframes nf-float-2 {
		0%,
		100% {
			transform: translate(0, 0) scale(1);
		}
		33% {
			transform: translate(50px, -40px) scale(1.05);
		}
		66% {
			transform: translate(-30px, 20px) scale(0.92);
		}
	}
	@keyframes nf-float-3 {
		0%,
		100% {
			transform: translate(0, 0) scale(1);
		}
		50% {
			transform: translate(-60px, 40px) scale(1.12);
		}
	}

	.nf-card {
		position: relative;
		z-index: 1;
		text-align: center;
		max-width: 26rem;
		width: 100%;
		padding: 2rem 2.5rem 2.5rem;
		margin: 1.5rem;
		border-radius: 1.5rem;
		border: 1px solid var(--surface-border);
		background: color-mix(in srgb, var(--surface-bg) 90%, transparent);
		backdrop-filter: blur(24px);
		-webkit-backdrop-filter: blur(24px);
		box-shadow:
			0 1px 3px rgb(0 0 0 / 0.04),
			0 25px 50px -12px rgb(0 0 0 / 0.12),
			0 0 0 1px rgb(255 255 255 / 0.05) inset;
	}

	.nf-cat {
		width: 100%;
		max-width: 20rem;
		border-radius: 0.75rem;
		margin: 0 auto 1.5rem;
		display: block;
		object-fit: cover;
	}

	.nf-title {
		font-size: 1.125rem;
		font-weight: 600;
		color: var(--center-channel-color);
		margin-bottom: 1.5rem;
		line-height: 1.5;
	}
</style>
