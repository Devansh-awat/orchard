import assert from 'node:assert/strict';
import test from 'node:test';
import { escapeHtml, safeHttpUrl } from './html.ts';
import { escapeLine, podBadge } from './log-lines.ts';

test('podBadge escapes hostile pod names and ignores non-strings', () => {
	const b = podBadge('x-<img src=x onerror=alert(1)>');
	assert.ok(!b.html.includes('<img'));
	assert.ok(b.html.includes('&lt;img'));
	assert.deepEqual(podBadge({ a: 1 }), { label: '', html: '' });
	assert.equal(podBadge('backend-cb974cb4c-vjvfb').label, 'vjvfb');
});

test('escapeHtml neutralises markup and attribute breakouts', () => {
	assert.equal(
		escapeHtml(`<img src=x onerror="a('b')">&`),
		'&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;'
	);
	assert.equal(escapeHtml(undefined), '');
	assert.equal(escapeHtml(12), '12');
});

test('escapeLine escapes log text', () => {
	assert.equal(escapeLine('<script>x</script>'), '&lt;script&gt;x&lt;/script&gt;');
});

test('safeHttpUrl allows only http and https', () => {
	assert.equal(safeHttpUrl('https://github.com/a/b'), 'https://github.com/a/b');
	assert.equal(safeHttpUrl('http://example.com'), 'http://example.com/');
	assert.equal(safeHttpUrl('javascript:alert(1)'), undefined);
	assert.equal(safeHttpUrl(' JavaScript:alert(1)'), undefined);
	assert.equal(safeHttpUrl('data:text/html,x'), undefined);
	assert.equal(safeHttpUrl('nope'), undefined);
	assert.equal(safeHttpUrl(null), undefined);
});
