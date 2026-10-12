const path = require('node:path');
const Module = require('node:module');

const [bundle, projectDir] = process.argv.slice(2);
const req = Module.createRequire(path.join(projectDir, 'package.json'));
req('reflect-metadata');
const loaded = require(bundle);
const entry = loaded.default ?? loaded.GraftModule;
if (!entry) {
  process.stderr.write('server entry must export a Nest module as default or GraftModule\n');
  process.exit(1);
}

const hostish = new Set();
for (const [file, cached] of Object.entries(require.cache)) {
  if (file === bundle || !cached || !cached.exports) continue;
  const exported = cached.exports;
  if (typeof exported === 'function') hostish.add(exported);
  if (exported && typeof exported === 'object') {
    for (const key of Object.keys(exported)) {
      try {
        if (typeof exported[key] === 'function') hostish.add(exported[key]);
      } catch {}
    }
  }
}

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD', 'SEARCH'];
const meta = (key, target) => Reflect.getMetadata(key, target);
const authOf = (t) => ({
  isPublic: meta('isPublic', t),
  requiresAuth: meta('requiresAuth', t),
  requiresSuperadmin: meta('requires_superadmin', t)
});
function classify(h, c) {
  if (h.requiresSuperadmin || c.requiresSuperadmin) return 'superadmin';
  if (h.isPublic) return 'public';
  if (h.requiresAuth || c.requiresAuth) return 'authenticated';
  if (c.isPublic) return 'public';
  return 'superadmin';
}
const join = (...parts) => `/${parts.join('/')}`.replace(/\/+/g, '/').replace(/\/$/, '') || '/';

const routes = {};
const uses = {};
const conflicts = [];
const classes = new Set();
const seen = new Set();

function noteTokens(cls) {
  const tokens = [
    ...(meta('self:paramtypes', cls) ?? []).map((p) => p.param),
    ...(meta('self:properties_metadata', cls) ?? []).map((p) => p.type)
  ];
  for (const token of tokens) {
    if (typeof token !== 'symbol') continue;
    const key = Symbol.keyFor(token);
    const match = key && /^orchard\.graft\.door\.([a-zA-Z.]+)@(\d+)$/.exec(key);
    if (!match) continue;
    const prior = uses[match[1]];
    if (prior && prior !== Number(match[2]))
      conflicts.push(`door ${match[1]} is used at versions ${prior} and ${match[2]}`);
    uses[match[1]] = Number(match[2]);
  }
}

function visit(mod) {
  const cls = typeof mod === 'function' ? mod : mod && mod.module;
  if (!cls || seen.has(cls) || hostish.has(cls)) return;
  seen.add(cls);
  const dynamic = typeof mod === 'function' ? null : mod;
  for (const ctrl of [
    ...(meta('controllers', cls) ?? []),
    ...((dynamic && dynamic.controllers) || [])
  ]) {
    if (hostish.has(ctrl)) continue;
    classes.add(ctrl);
    const base = meta('path', ctrl);
    if (base === undefined) continue;
    const classAuth = authOf(ctrl);
    for (const name of Object.getOwnPropertyNames(ctrl.prototype)) {
      const handler = ctrl.prototype[name];
      if (name === 'constructor' || typeof handler !== 'function') continue;
      const method = meta('method', handler);
      if (method === undefined) continue;
      const h = authOf(handler);
      if (h.isPublic && h.requiresAuth)
        conflicts.push(`${ctrl.name}.${name} has both @Auth() and @Public()`);
      const sub = meta('path', handler) ?? '';
      for (const b of Array.isArray(base) ? base : [base]) {
        for (const s of Array.isArray(sub) ? sub : [sub]) {
          routes[`${METHODS[method]} ${join(b, s)}`] = classify(h, classAuth);
        }
      }
    }
  }
  for (const provider of [
    ...(meta('providers', cls) ?? []),
    ...((dynamic && dynamic.providers) || [])
  ]) {
    const pc = typeof provider === 'function' ? provider : provider && provider.useClass;
    if (pc && !hostish.has(pc)) classes.add(pc);
  }
  for (const imp of [...(meta('imports', cls) ?? []), ...((dynamic && dynamic.imports) || [])])
    visit(imp);
}

visit(entry);
for (const cls of classes) noteTokens(cls);
const sorted = Object.fromEntries(Object.entries(routes).sort(([a], [b]) => a.localeCompare(b)));
process.stdout.write(JSON.stringify({ routes: sorted, uses, conflicts }));
