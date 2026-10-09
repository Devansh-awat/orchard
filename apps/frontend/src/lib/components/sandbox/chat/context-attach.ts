import { apiFetch } from '$lib/stores';
import { ocBase, type OcMessage } from '../opencode';
import { transcriptFileName, transcriptMarkdown } from './transcript-text';

export type ContextChat = { id: string; title: string; directory: string | null; hint?: string };

export type ContextPlan = { path: string; name: string; label: string };

export function textFile(name: string, content: string): File {
	return new File([content], name, { type: 'text/plain' });
}

export async function chatTranscriptFile(sandboxId: string, chat: ContextChat): Promise<File> {
	const dir = chat.directory ? `&directory=${encodeURIComponent(chat.directory)}` : '';
	const res = await apiFetch(`${ocBase(sandboxId)}/session/${chat.id}/message?limit=200${dir}`);
	if (!res.ok) throw new Error('Could not load that chat');
	const messages = (await res.json()) as OcMessage[];
	return textFile(transcriptFileName(chat.title), transcriptMarkdown(chat.title, messages));
}
