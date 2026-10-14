// Conventional commits drive every version bump and changelog entry, so the
// commit message IS the release input. The scope routes a commit to a service:
//
//   feat(server): ...     -> bumps `server` only (minor)
//   fix(r2-proxy): ...    -> bumps `r2-proxy` only (patch)
//   feat!: ...  / BREAKING CHANGE footer -> major
//   feat: ...  (no scope) -> repo-wide: bumps EVERY service + the umbrella
//   chore/docs/test/...   -> no release (still allowed)
//
// The umbrella (`orchard`) version always tracks the highest bump seen.
module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Empty scope is allowed and means "repo-wide". When a scope is given it
    // must be a real service (or a meta scope) so it routes correctly.
    'scope-enum': [
      2,
      'always',
      [
        'server',
        'frontend',
        'gateway',
        'cli',
        'r2-proxy',
        'r2proxy',
        'registry',
        'templates',
        'sandbox',
        'chart',
        'release',
        'ci',
        'deps',
        'repo'
      ]
    ]
  }
};
