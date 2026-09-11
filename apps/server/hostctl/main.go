package main

import (
	"os"
	"path/filepath"

	"github.com/hackclub/orchard/orchardctl/internal/cli"
	"github.com/hackclub/orchard/orchardctl/internal/commands"
)

func main() {
	registry := cli.NewRegistry(commands.All()...)
	os.Exit(cli.Main(registry, filepath.Base(os.Args[0]), os.Args[1:]))
}
