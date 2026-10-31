import { marked } from 'marked';
import { parseFrontmatter } from './meta';

export interface UpdateSection {
	icon: string;
	title: string;
	html: string;
}

export interface Update {
	id: string;
	title: string;
	date: string;
	tag: string;
	summary: string;
	intro: string;
	sections: UpdateSection[];
}

const HEADING = /^###\s+(?:\[([\w-]+)\]\s*)?(.+)$/;

function render(markdown: string): string {
	const trimmed = markdown.trim();
	return trimmed ? (marked.parse(trimmed, { async: false }) as string) : '';
}

function parseSections(body: string): { intro: string; sections: UpdateSection[] } {
	const lines = body.split(/\r?\n/);
	const introLines: string[] = [];
	const sections: UpdateSection[] = [];
	let current: { icon: string; title: string; lines: string[] } | null = null;

	for (const line of lines) {
		const heading = line.match(HEADING);
		if (heading) {
			if (current) {
				sections.push({
					icon: current.icon,
					title: current.title,
					html: render(current.lines.join('\n'))
				});
			}
			current = { icon: heading[1] ?? '', title: heading[2].trim(), lines: [] };
			continue;
		}
		if (current) current.lines.push(line);
		else introLines.push(line);
	}

	if (current) {
		sections.push({
			icon: current.icon,
			title: current.title,
			html: render(current.lines.join('\n'))
		});
	}

	return { intro: render(introLines.join('\n')), sections };
}

export function parseUpdate(raw: string): Update | null {
	const { meta, body } = parseFrontmatter(raw);
	if (!meta.id || !meta.date) return null;
	const { intro, sections } = parseSections(body);
	return {
		id: meta.id,
		title: meta.title || meta.id,
		date: meta.date,
		tag: meta.tag || 'New',
		summary: meta.summary || '',
		intro,
		sections
	};
}
