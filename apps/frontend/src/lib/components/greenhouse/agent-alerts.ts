import type { AgentSignalKind } from '$lib/components/sandbox/chat/session-store.svelte';
import { stripSycophancy } from '$lib/components/sandbox/chat/sycophancy';

export type AlertCopy = { title: string; body: string };

const BODY_MAX = 140;

export function firstLine(text: string | null | undefined, max = BODY_MAX): string {
	if (!text) return '';
	const line =
		text
			.replace(/```[\s\S]*?(?:```|$)/g, ' ')
			.split('\n')
			.map((l) =>
				l
					.replace(/^\s*(?:#{1,6}|[-*+>]|\d+[.)])\s+/, '')
					.replace(/[*_`]+/g, '')
					.trim()
			)
			.find(Boolean) ?? '';
	return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

export function alertCopy(
	kind: AgentSignalKind,
	sessionTitle: string,
	detail: string | null,
	tidy: boolean
): AlertCopy {
	const name = sessionTitle.trim() || 'Your session';
	const text = detail && tidy ? stripSycophancy(detail) : detail;
	if (kind === 'done') return { title: `${name} finished`, body: firstLine(text) };
	if (kind === 'attention') {
		return {
			title: `${name} needs you`,
			body: firstLine(text) || 'The agent is waiting for an answer'
		};
	}
	return { title: `${name} hit an error`, body: firstLine(text) };
}

export function notificationsAllowed(): boolean {
	return typeof Notification !== 'undefined' && Notification.permission === 'granted';
}

export function askNotificationPermission() {
	if (typeof Notification === 'undefined' || Notification.permission !== 'default') return;
	void Notification.requestPermission().catch(() => undefined);
}

export function showAgentNotification(copy: AlertCopy, tag: string, onOpen: () => void): boolean {
	if (!notificationsAllowed()) return false;
	try {
		const note = new Notification(copy.title, {
			body: copy.body || undefined,
			tag,
			icon: '/favicon/android-chrome-192x192.png'
		});
		note.onclick = () => {
			window.focus();
			onOpen();
			note.close();
		};
		return true;
	} catch {
		return false;
	}
}
