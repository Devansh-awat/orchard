package main

import (
	"fmt"
	"os"

	"github.com/LeafdTK/leaf/cli/cmd"
)

func main() {
	if err := cmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, "✗ "+err.Error())
		os.Exit(1)
	}
}
