import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_GROUPS,
  MAX_GROUP_LENGTH,
  extractGroups,
  normalizeGroup,
  resolveRoles,
  ruleValue,
  validClaimName
} from '../src/sso/group-rules';

const rule = (id: string, value: string, role: string, organizationId = 'org') => ({
  id,
  organizationId,
  value,
  role
});

test('group names are NFC normalised and trimmed, never case folded', () => {
  const composed = 'équipe';
  const decomposed = 'équipe';
  assert.equal(normalizeGroup(decomposed), composed);
  assert.equal(normalizeGroup(`  ${composed}  `), composed);
  assert.notEqual(normalizeGroup('Admins'), normalizeGroup('admins'));
});

test('unusable group names are dropped', () => {
  assert.equal(normalizeGroup(''), null);
  assert.equal(normalizeGroup('   '), null);
  assert.equal(normalizeGroup(42), null);
  assert.equal(normalizeGroup('a\u0000b'), null);
  assert.equal(normalizeGroup('adm​ins'), null);
  assert.equal(normalizeGroup('a‮b'), null);
  assert.equal(normalizeGroup('x'.repeat(MAX_GROUP_LENGTH + 1)), null);
  assert.equal(normalizeGroup('x'.repeat(MAX_GROUP_LENGTH))?.length, MAX_GROUP_LENGTH);
});

test('rule values reject lookalike mixed scripts but allow a single non-Latin script', () => {
  assert.throws(() => ruleValue('Аdmins'));
  assert.throws(() => ruleValue('Ρroject'));
  assert.equal(ruleValue('Админы'), 'Админы');
  assert.equal(ruleValue('eng-admins 2024'), 'eng-admins 2024');
  assert.throws(() => ruleValue('zero​width'));
});

test('homoglyph groups from the IdP never match a Latin rule', () => {
  const groups = extractGroups({ groups: ['Аdmins'] }, 'groups');
  assert.equal(groups.kind, 'groups');
  if (groups.kind === 'groups') {
    assert.equal(resolveRoles([rule('r1', 'Admins', 'admin')], groups.groups).size, 0);
  }
});

test('a missing claim is an empty group list, not an error', () => {
  const r = extractGroups({ sub: 'x' }, 'groups');
  assert.deepEqual(r, { kind: 'groups', groups: new Set() });
});

test('a single string claim is one group, duplicates collapse, non-strings are ignored', () => {
  assert.deepEqual(extractGroups({ groups: 'eng' }, 'groups'), {
    kind: 'groups',
    groups: new Set(['eng'])
  });
  const r = extractGroups({ groups: ['eng', 'eng', ' eng ', 7, null, { a: 1 }] }, 'groups');
  assert.deepEqual(r, { kind: 'groups', groups: new Set(['eng']) });
});

test('huge claims are unknown, never truncated into a grant', () => {
  const many = Array.from({ length: MAX_GROUPS + 1 }, (_, i) => `g${i}`);
  assert.deepEqual(extractGroups({ groups: many }, 'groups'), {
    kind: 'unknown',
    reason: 'too_many'
  });
  const fat = Array.from({ length: 100 }, (_, i) => `${i}-${'x'.repeat(200)}`);
  assert.deepEqual(extractGroups({ groups: fat }, 'groups'), {
    kind: 'unknown',
    reason: 'too_large'
  });
  const edge = Array.from({ length: MAX_GROUPS }, (_, i) => `g${i}`);
  assert.equal(extractGroups({ groups: edge }, 'groups').kind, 'groups');
});

test('overage markers mean unknown, not empty', () => {
  assert.deepEqual(extractGroups({ hasgroups: true }, 'groups'), {
    kind: 'unknown',
    reason: 'overage'
  });
  assert.deepEqual(
    extractGroups({ _claim_names: { groups: 'src1' }, _claim_sources: {} }, 'groups'),
    { kind: 'unknown', reason: 'overage' }
  );
  assert.equal(extractGroups({ groups: ['a'], hasgroups: true }, 'groups').kind, 'groups');
});

test('claim lookup takes a literal key first, then a bounded dotted path', () => {
  assert.deepEqual(extractGroups({ 'a.b': ['x'], a: { b: ['y'] } }, 'a.b'), {
    kind: 'groups',
    groups: new Set(['x'])
  });
  assert.deepEqual(extractGroups({ realm_access: { roles: ['admin'] } }, 'realm_access.roles'), {
    kind: 'groups',
    groups: new Set(['admin'])
  });
  assert.deepEqual(extractGroups({ a: { b: { c: { d: { e: ['x'] } } } } }, 'a.b.c.d.e'), {
    kind: 'groups',
    groups: new Set()
  });
});

test('prototype keys are never a claim path', () => {
  assert.equal(validClaimName('__proto__'), false);
  assert.equal(validClaimName('a.constructor'), false);
  assert.equal(validClaimName(' groups'), false);
  assert.equal(validClaimName(''), false);
  assert.equal(validClaimName('x'.repeat(257)), false);
  assert.equal(validClaimName('http://schemas.xmlsoap.org/claims/Group'), true);
  assert.deepEqual(extractGroups({}, '__proto__'), { kind: 'unknown', reason: 'malformed' });
  assert.deepEqual(extractGroups({ a: {} }, 'a.__proto__.x'), {
    kind: 'unknown',
    reason: 'malformed'
  });
  const inherited = Object.create({ groups: ['admins'] });
  assert.deepEqual(extractGroups(inherited, 'groups'), { kind: 'groups', groups: new Set() });
});

test('highest role wins per organization and orgs resolve independently', () => {
  const rules = [
    rule('1', 'eng', 'member'),
    rule('2', 'leads', 'admin'),
    rule('3', 'guests', 'guest'),
    rule('4', 'eng', 'guest', 'other')
  ];
  const out = resolveRoles(rules, new Set(['eng', 'leads', 'guests']));
  assert.deepEqual(out.get('org'), { role: 'admin', ruleIds: ['2'] });
  assert.deepEqual(out.get('other'), { role: 'guest', ruleIds: ['4'] });
});

test('a stored owner rule can never resolve', () => {
  const out = resolveRoles([rule('1', 'root', 'owner')], new Set(['root']));
  assert.equal(out.size, 0);
  const mixed = resolveRoles(
    [rule('1', 'root', 'owner'), rule('2', 'eng', 'member')],
    new Set(['root', 'eng'])
  );
  assert.deepEqual(mixed.get('org'), { role: 'member', ruleIds: ['2'] });
});

test('matching is exact: no prefix, substring or case-insensitive hits', () => {
  const rules = [rule('1', 'Admins', 'admin')];
  for (const g of ['admins', 'Admins2', 'xAdmins', 'ADMINS', 'Admins ']) {
    const r = extractGroups({ groups: [g] }, 'groups');
    assert.ok(r.kind === 'groups');
    if (r.kind === 'groups' && g !== 'Admins ') assert.equal(resolveRoles(rules, r.groups).size, 0);
  }
  const trimmed = extractGroups({ groups: ['Admins '] }, 'groups');
  if (trimmed.kind === 'groups') assert.equal(resolveRoles(rules, trimmed.groups).size, 1);
});
