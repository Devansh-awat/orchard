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

Append to the registry in `main.go`. `internal/cli` derives the help text, the
root gating and the hyphenated alias from the `Command` struct, so nothing else
has to be kept in step:

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

The dispatcher and the values layer are covered. Both are places where a
mistake is silent rather than loud: a bad alias turns a command into a help
screen, and a bad values write corrupts an operator's configuration.
