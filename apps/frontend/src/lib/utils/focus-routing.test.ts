import test from 'node:test';
import assert from 'node:assert/strict';
import {
	holdsTextEntry,
	inCodeEditor,
	inTerminal,
	mayTakeFocus,
	type FocusTarget
} from './focus-routing';

function el(
	tagName: string,
	opts: {
		within?: string[];
		editable?: boolean;
		role?: string;
		keyboard?: boolean;
	} = {}
): FocusTarget {
	const within = opts.within ?? [];
	return {
		tagName,
		isContentEditable: opts.editable ?? false,
		getAttribute: (name) => (name === 'role' ? (opts.role ?? null) : null),
		closest: (selector) => (within.includes(selector) ? {} : null),
		matches: (selector) => selector === ':focus-visible' && (opts.keyboard ?? false)
	};
}

const nobody = () => false;

test('monaco and terminals are recognised from inside', () => {
	assert.equal(inCodeEditor(el('DIV', { within: ['.monaco-editor'] })), true);
	assert.equal(inTerminal(el('TEXTAREA', { within: ['.pod-terminal'] })), true);
	assert.equal(inCodeEditor(null), false);
});

test('text entry covers fields, contenteditable, textboxes and the code editor', () => {
	assert.equal(holdsTextEntry(el('INPUT')), true);
	assert.equal(holdsTextEntry(el('TEXTAREA')), true);
	assert.equal(holdsTextEntry(el('DIV', { editable: true })), true);
	assert.equal(holdsTextEntry(el('DIV', { role: 'textbox' })), true);
	assert.equal(holdsTextEntry(el('DIV', { within: ['.monaco-editor'] })), true);
	assert.equal(holdsTextEntry(el('BUTTON')), false);
});

test('a reconnecting terminal never pulls focus out of the editor', () => {
	const editor = el('DIV', { within: ['.monaco-editor'] });
	assert.equal(mayTakeFocus(editor, nobody), false);
});

test('the editor never pulls focus out of a terminal or the composer', () => {
	assert.equal(mayTakeFocus(el('TEXTAREA', { within: ['.pod-terminal'] }), nobody), false);
	assert.equal(mayTakeFocus(el('TEXTAREA'), nobody), false);
});

test('focus moves after a click but not mid keyboard navigation', () => {
	assert.equal(mayTakeFocus(el('BUTTON'), nobody), true);
	assert.equal(mayTakeFocus(el('BUTTON', { keyboard: true }), nobody), false);
});

test('nothing focused, or focus already inside, always allows it', () => {
	assert.equal(mayTakeFocus(null, nobody), true);
	assert.equal(mayTakeFocus(el('BODY'), nobody), true);
	const own = el('TEXTAREA');
	assert.equal(
		mayTakeFocus(own, (x) => x === own),
		true
	);
});
