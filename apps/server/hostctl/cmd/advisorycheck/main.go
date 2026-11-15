package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/hackclub/orchard/orchardctl/internal/commands"
)

func findRoot(start string) (string, error) {
	dir, err := filepath.Abs(start)
	if err != nil {
		return "", err
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "install", "install.sh")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", errors.New("no install/install.sh above this directory; pass -root")
		}
		dir = parent
	}
}

func run(args []string, stdout, stderr io.Writer, check func(root string) (commands.ShippedReport, error)) int {
	flags := flag.NewFlagSet("advisorycheck", flag.ContinueOnError)
	flags.SetOutput(stderr)
	root := flags.String("root", "", "the repository root (default: found from the working directory)")
	markdown := flags.String("markdown", "", "also write the report as Markdown to this file")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	dir := *root
	if dir == "" {
		found, err := findRoot(".")
		if err != nil {
			fmt.Fprintln(stderr, err)
			return 2
		}
		dir = found
	}
	report, err := check(dir)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	fmt.Fprint(stdout, report.Text())
	if *markdown != "" {
		if err := os.WriteFile(*markdown, []byte(report.Markdown()), 0o644); err != nil {
			fmt.Fprintln(stderr, err)
			return 2
		}
	}
	status := report.Status()
	switch status {
	case commands.ShippedNeedsYou:
		fmt.Fprintln(stderr, "\nA shipped component has a known advisory. Bump its pin, or read the advisory if no release fixes it.")
	case commands.ShippedUnreachable:
		fmt.Fprintln(stderr, "\nCould not check every component: OSV.dev, a registry or a chart repository did not answer.")
	}
	return status
}

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr, commands.CheckShipped))
}
