# orchardctl

The commands installed on an Orchard host: upgrading the instance, changing its
configuration, getting back in. Not the same thing as `apps/cli`, which deploys
apps to any instance over its API.

## Why it lives here

Under `apps/server` on purpose. release-please cuts releases per package and
images publish on release, so host commands kept anywhere else would never reach
a published image. A change here counts as a server change, which is what
carries them.

## How it reaches a host

Built for linux/amd64 and linux/arm64 into `/app/hostbin/` in the server image.
`apps/server/hostbin/orchard-sync-commands` — the one remaining shell script —
copies the matching build out with `kubectl exec` and links the hyphenated
aliases at it. That script stays shell because `install.sh` reads it out of the
image before anything is installed, and it is the only thing that can recover a
host with no `orchardctl` on it.

## Adding a command

Append to `commands.All()`. `internal/cli` derives the help text and the root
gating from the `Command` struct:

```go
&cli.Command{
    Name:    "backup",
    Args:    "...",
    Summary: "one line, shown in the top-level listing",
    Usage:   "the long help, printed for --help",
    Root:    true,  // touches the 0600 values file or the cluster
    Run:     func(c *cli.Context, args []string) error { ... },
}
```

The hyphenated alias is the one thing that is not automatic. Two lists name the
symlinks, `commands.Aliases` and the `ALIASES` line in
`apps/server/hostbin/orchard-sync-commands`, because the shell bootstrap is what
runs on the first sync of an upgrade. A test pins them together and pins both
against the registry, since the failure is silent: the alias never appears on
the host and the command looks like it was never shipped.

`Context` carries the resolved paths and the ways a command may reach outside:
`Run` streams a child process through (so helm keeps its progress output),
`Capture` returns stdout, `Kubectl` prefixes the namespace.

Values live behind `cli.LoadValues`, which reads and writes the chart values as
YAML. Editing them in Go rather than shelling out to `yq` is most of why this
stopped being a shell script: a list of objects like `builders.registryEgress`
is painful through a yq expression and easy here.

## Tests

```bash
go test ./...
```

The dispatcher, the values layer, and what `mcp enable` writes are covered. All
three are places where a mistake is silent rather than loud: a bad alias turns a
command into a help screen, a bad values write corrupts an operator's
configuration, and an MCP missing its shared credential starts cleanly and then
fails every tool call.

The host defaults `update` applies (`applyHostDefaults` in
`internal/commands/defaults.go`) are covered too, because they rewrite the
values file of every installer host on its next upgrade.

## New defaults for existing hosts

`install.sh` writes a fresh host's values with everything on. An older host gets
the same on `orchardctl update`, through `applyHostDefaults`: it fills in only
keys missing from the values file, runs once per round, and records the round in
the top-level `hostDefaults` key so an operator who turns something back off is
not overridden on the next upgrade. To turn on something new by default, add a
round: bump `hostDefaultsVersion` here and `HOST_DEFAULTS_VERSION` in
`install/install.sh` together, gate the new steps on the previous round, and
print every change.

## Signed releases

Release images sign the host commands. The server image build writes `hostbin.manifest` and
`hostbin.sig` in one step that sees the `HOSTCTL_SIGNING_KEY` secret. `orchardctl sync` checks them
against `internal/release/keys.go` before it replaces itself, and refuses an older release.
`apps/server/hostbin/orchard-sync-commands` and `install/install.sh` hold the same keys.

Checks stay off while `keys.go` is empty. A release build fails if keys are set and the secret is
missing or doesn't match, because hosts would refuse that release.
