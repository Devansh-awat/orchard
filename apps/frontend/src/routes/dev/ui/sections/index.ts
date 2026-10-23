import type { Component } from 'svelte';
import Foundations from './Foundations.svelte';
import Type from './Type.svelte';
import Buttons from './Buttons.svelte';
import Status from './Status.svelte';
import Feedback from './Feedback.svelte';
import Inputs from './Inputs.svelte';
import Tabs from './Tabs.svelte';
import Lists from './Lists.svelte';
import Small from './Small.svelte';
import Menus from './Menus.svelte';
import Pickers from './Pickers.svelte';
import Overlays from './Overlays.svelte';
import Forms from './Forms.svelte';
import Data from './Data.svelte';
import Progress from './Progress.svelte';
import Patterns from './Patterns.svelte';

export type Section = { id: string; title: string; group: string; component: Component };

export const SECTIONS: Section[] = [
	{
		id: 'foundations',
		title: 'Colour, radius, space',
		group: 'Foundations',
		component: Foundations
	},
	{ id: 'type', title: 'Type', group: 'Foundations', component: Type },
	{ id: 'buttons', title: 'Buttons', group: 'Actions', component: Buttons },
	{ id: 'menus', title: 'Menus', group: 'Actions', component: Menus },
	{ id: 'inputs', title: 'Inputs', group: 'Forms', component: Inputs },
	{ id: 'forms', title: 'Choices and forms', group: 'Forms', component: Forms },
	{ id: 'pickers', title: 'Pickers', group: 'Forms', component: Pickers },
	{ id: 'tabs', title: 'Tabs', group: 'Navigation', component: Tabs },
	{ id: 'lists', title: 'Lists and cards', group: 'Data', component: Lists },
	{ id: 'data', title: 'Tables, code and logs', group: 'Data', component: Data },
	{ id: 'status', title: 'Status', group: 'Feedback', component: Status },
	{ id: 'feedback', title: 'Toasts and alerts', group: 'Feedback', component: Feedback },
	{ id: 'progress', title: 'Progress and loading', group: 'Feedback', component: Progress },
	{ id: 'overlays', title: 'Dialogs, sheets and popovers', group: 'Overlays', component: Overlays },
	{ id: 'small', title: 'Small things', group: 'Details', component: Small },
	{ id: 'patterns', title: 'App patterns', group: 'Patterns', component: Patterns }
];
