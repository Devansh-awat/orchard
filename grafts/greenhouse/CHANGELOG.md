# Changelog

## [1.5.1](https://github.com/hackclub/orchard/compare/greenhouse/v1.5.0...greenhouse/v1.5.1) (2026-10-21)


### Bug Fixes

* bump mcp sdk, sharp and patched transitive deps for open advisories ([d11e502](https://github.com/hackclub/orchard/commit/d11e502448535a0fbc7a9a17f07c2653da0b8014))

## [1.5.0](https://github.com/hackclub/orchard/compare/greenhouse/v1.4.1...greenhouse/v1.5.0) (2026-10-16)


### Features

* greenhouse opens folders anywhere, runs named commands and names sessions ([5043f0c](https://github.com/hackclub/orchard/commit/5043f0c27aa4c8603a22a97ca68683c2bcec742d))

## [1.4.1](https://github.com/hackclub/orchard/compare/greenhouse/v1.4.0...greenhouse/v1.4.1) (2026-10-15)


### Bug Fixes

* machines run the agent host from cli 0.29.0 so agents can sign in from settings ([a180f5c](https://github.com/hackclub/orchard/commit/a180f5cf0dab8c054edf0312c25801108159a256))

## [1.4.0](https://github.com/hackclub/orchard/compare/greenhouse/v1.3.3...greenhouse/v1.4.0) (2026-10-15)


### Features

* greenhouse agents sign in from settings and the model picker lists agents cleanly ([0395d45](https://github.com/hackclub/orchard/commit/0395d45ca4d6c71c194974432eb5f940b9c97f26))


### Bug Fixes

* cli parity follows graft route aliases and the agent sign-in routes are covered ([8adb384](https://github.com/hackclub/orchard/commit/8adb384bb2c1121225b6229c36661e33597bd3eb))

## [1.3.3](https://github.com/hackclub/orchard/compare/greenhouse/v1.3.2...greenhouse/v1.3.3) (2026-10-15)


### Bug Fixes

* existing vercel machines open the daemon port when they start or resync ([6425a17](https://github.com/hackclub/orchard/commit/6425a17fbc670371902489173bc0013499859f08))

## [1.3.2](https://github.com/hackclub/orchard/compare/greenhouse/v1.3.1...greenhouse/v1.3.2) (2026-10-14)


### Bug Fixes

* greenhouse settings list every coding agent, claude usage survives anthropic rate limits, and existing kubernetes machines fetch the daemon ([a29a3d2](https://github.com/hackclub/orchard/commit/a29a3d2feac6522756682bcc9f8aaa5defca9a4d))

## [1.3.1](https://github.com/hackclub/orchard/compare/greenhouse/v1.3.0...greenhouse/v1.3.1) (2026-10-14)


### Bug Fixes

* rollouts drain gracefully and greenhouses reconnect at once instead of going unavailable for a minute ([b275cae](https://github.com/hackclub/orchard/commit/b275cae7f5a3455e26034369e7e20fb187c21537))
* vercel machines run the machine daemon from cli 0.28.1 ([a958fdc](https://github.com/hackclub/orchard/commit/a958fdcc554f2b7581c2869f0762373d77c73081))

## [1.3.0](https://github.com/hackclub/orchard/compare/greenhouse/v1.2.0...greenhouse/v1.3.0) (2026-10-14)


### Features

* greenhouse sessions open instantly from a warm pool and chats run claude code, opencode, fx or codex over acp ([dad8ae6](https://github.com/hackclub/orchard/commit/dad8ae6959e50772c5397c1b4758c23c9a2d6581))

## [1.2.0](https://github.com/hackclub/orchard/compare/greenhouse/v1.1.0...greenhouse/v1.2.0) (2026-10-14)


### Features

* community grafts and taps next to official ones, sdk and ui kit publish to npm as [@orchardlabs](https://github.com/orchardlabs) ([fae981d](https://github.com/hackclub/orchard/commit/fae981de67a90b03974129c3408fbaf01e8ff68a))

## [1.1.0](https://github.com/hackclub/orchard/compare/greenhouse/v1.0.0...greenhouse/v1.1.0) (2026-10-14)


### Features

* graft database pools are sized per graft and checked against the database limit ([b34981d](https://github.com/hackclub/orchard/commit/b34981d23c7b84ed1aa3572c0aca7a478a5a000e))
* greenhouse runs as a graft ([7a808df](https://github.com/hackclub/orchard/commit/7a808df9cc102446361b5369d7ea0b01172e3e87))


### Bug Fixes

* grafts declare the core tables they take over so greenhouse passes doctor ([8c1cb21](https://github.com/hackclub/orchard/commit/8c1cb2162d2b48fd82a37006786a7c173b88a220))
