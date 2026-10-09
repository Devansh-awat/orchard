import type { PipPose } from '../mascot/pip';

export const TOUR_SESSION = '11111111-1111-4111-8111-111111111111';

export type TourStep =
	| { kind: 'session'; id: string | null }
	| { kind: 'click'; selector: string }
	| { kind: 'escape' };

export interface TourBeat {
	id: string;
	title: string;
	text: string;
	pose: PipPose;
	target: string | null;
	before?: TourStep[];
}

const CLOSE: TourStep[] = [{ kind: 'escape' }];

export const TOUR_BEATS: TourBeat[] = [
	{
		id: 'hello',
		title: 'Welcome to Greenhouse',
		text: 'Hi, I’m Pip. Let me show you around before you start. It takes about a minute.',
		pose: 'wave',
		target: null,
		before: [{ kind: 'session', id: null }]
	},
	{
		id: 'machine',
		title: 'Your machine',
		text: 'This is your own computer in the cloud. It sleeps when you step away and wakes up in seconds. Start it here whenever it is asleep.',
		pose: 'idle',
		target: '[data-tour="machine"]'
	},
	{
		id: 'repos',
		title: 'Repositories and sessions',
		text: 'Your repositories live on the machine. Each session under them is its own branch in its own folder, so you can run as many as you like side by side.',
		pose: 'idle',
		target: '[data-tour="repos"] > *'
	},
	{
		id: 'chat',
		title: 'Chats and the agent',
		text: 'Every session has chats with the agent. You see each step it takes, and the line at the bottom shows what it is doing right now.',
		pose: 'thinking',
		target: '.chat:not(.chat--hidden)',
		before: [{ kind: 'session', id: TOUR_SESSION }]
	},
	{
		id: 'changes',
		title: 'Changes',
		text: 'Everything the agent edits shows up here. Review it, commit it and push it, all as yourself.',
		pose: 'idle',
		target: '[data-tour="changes"]'
	},
	{
		id: 'pr',
		title: 'Pull requests',
		text: 'When it looks right, open a pull request. Checks and the PR status show up in the Checks tab.',
		pose: 'happy',
		target: '[data-tour="pr"]'
	},
	{
		id: 'dock',
		title: 'The dock',
		text: 'Setup and run scripts, your terminals and every open port live down here. Ports turn into previews you can open.',
		pose: 'idle',
		target: '[data-tour="dock"]',
		before: [{ kind: 'click', selector: '[data-tour="ports"]' }]
	},
	{
		id: 'share',
		title: 'Sharing',
		text: 'Share the machine and you stay the host. Guests collaborate or watch read only, push with their own GitHub account, and every prompt shows who sent it.',
		pose: 'wave',
		target: '[data-tour="share"]',
		before: CLOSE
	},
	{
		id: 'ssh',
		title: 'Your own editor',
		text: 'Prefer VS Code, Cursor or Zed? Install the Orchard CLI, log in, and run this once. It makes a key, adds it to your account and sets up SSH. Then the editor buttons open the machine directly.',
		pose: 'idle',
		target: '[data-tour="editor"]',
		before: CLOSE
	},
	{
		id: 'context',
		title: 'Coming from Claude Code?',
		text: 'Run this once to bring over your CLAUDE.md, subagents, slash commands, skills and MCP servers, or edit them right here.',
		pose: 'happy',
		target: 'dialog[open] .pane:has([data-tour="context"])',
		before: [
			...CLOSE,
			{ kind: 'click', selector: '.side [aria-label="Settings"]' },
			{ kind: 'click', selector: '[data-section="context"]' }
		]
	},
	{
		id: 'done',
		title: 'That’s Greenhouse',
		text: 'Your machine is ready when you are. Go build something good.',
		pose: 'happy',
		target: null,
		before: CLOSE
	}
];
