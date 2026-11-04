package cmd

import (
	"context"
	"errors"
	"slices"
	"time"

	"github.com/spf13/cobra"
)

const (
	greenhouseGraft     = "greenhouse"
	skipGreenhouseCheck = "orchard.skip-greenhouse-check"
)

var errGreenhouseMissing = errors.New("Greenhouse isn't installed on this instance")

var greenhouseConfirmed bool

type instanceFeatures struct {
	Grafts    *[]string `json:"grafts"`
	Sandboxes *bool     `json:"sandboxes"`
}

func (f instanceFeatures) greenhouse() (installed, known bool) {
	if f.Grafts != nil {
		return slices.Contains(*f.Grafts, greenhouseGraft), true
	}
	if f.Sandboxes != nil {
		return *f.Sandboxes, true
	}
	return false, false
}

func requireGreenhouse(cmd *cobra.Command, _ []string) error {
	greenhouseConfirmed = false
	if cmd.Annotations[skipGreenhouseCheck] != "" {
		return nil
	}
	cl, _, err := client()
	if err != nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(cmd.Context(), 5*time.Second)
	defer cancel()
	var features instanceFeatures
	if err := cl.GetJSON(ctx, "/instance/features", &features); err != nil {
		return nil
	}
	installed, known := features.greenhouse()
	if !known {
		return nil
	}
	if !installed {
		return errGreenhouseMissing
	}
	greenhouseConfirmed = true
	return nil
}

func skipGreenhouse(c *cobra.Command) *cobra.Command {
	if c.Annotations == nil {
		c.Annotations = map[string]string{}
	}
	c.Annotations[skipGreenhouseCheck] = "true"
	return c
}
