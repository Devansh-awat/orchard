import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUpdate } from './index';

function intro(markdown: string): string {
	const update = parseUpdate(`---\nid: test\ndate: 2026-01-01\n---\n${markdown}\n`);
	assert.ok(update);
	return update.intro;
}

test('markdown still renders', () => {
	const html = intro('Some **bold** text and a [link](https://orchard.my/docs).');
	assert.match(html, /<strong>bold<\/strong>/);
	assert.match(html, /<a href="https:\/\/orchard\.my\/docs">link<\/a>/);
});

test('inline html shows as text', () => {
	const html = intro('Hello <img src=x onerror=alert(1)> there');
	assert.doesNotMatch(html, /<img/);
	assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('block html shows as text', () => {
	const html = intro('<script>alert(1)</script>');
	assert.doesNotMatch(html, /<script/);
	assert.match(html, /&lt;script&gt;/);
});

test('section bodies get the same treatment', () => {
	const update = parseUpdate(
		'---\nid: test\ndate: 2026-01-01\n---\n### [rocket] Faster\n<svg onload=alert(1)></svg>\n'
	);
	assert.ok(update);
	assert.equal(update.sections.length, 1);
	assert.doesNotMatch(update.sections[0].html, /<svg/);
});

for (const [name, markdown] of [
	['inline', '[click](javascript:alert(1))'],
	['mixed case', '[click](JaVaScRiPt:alert(1))'],
	['data', '[click](data:text/html;base64,PHNjcmlwdD4=)'],
	['autolink', '<javascript:alert(1)>'],
	['reference', '[click][ref]\n\n[ref]: javascript:alert(1)']
] as const) {
	test(`only web links keep their target: ${name}`, () => {
		const html = intro(markdown);
		assert.doesNotMatch(html, /href=/);
	});
}

test('images only load from web addresses', () => {
	assert.match(
		intro('![alt](https://orchard.my/a.png)'),
		/<img src="https:\/\/orchard\.my\/a\.png"/
	);
	const html = intro('![alt](javascript:alert(1))');
	assert.doesNotMatch(html, /<img/);
	assert.match(html, /alt/);
});
