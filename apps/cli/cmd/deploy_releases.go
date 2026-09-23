package cmd

import (
	"strconv"

	"github.com/hackclub/orchard/cli/internal/output"
	"github.com/spf13/cobra"
)

func deployReleasesCmd() *cobra.Command {
	var limit int
	c := &cobra.Command{
		Use:   "releases <id>",
		Short: "Releases that took traffic, newest first, with what shipped alongside the image",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw any
			path := deployPath(args[0], "releases") + "?limit=" + strconv.Itoa(limit)
			if err := cl.GetJSON(cmd.Context(), path, &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			rows := [][]string{}
			for _, r := range asList(raw) {
				who := ""
				if u, ok := r["createdBy"].(map[string]any); ok {
					who = pick(u, "username")
				}
				rows = append(rows, []string{
					pick(r, "createdAt"),
					pick(r, "status"),
					pick(r, "strategy"),
					pick(r, "image"),
					pick(r, "replicas"),
					who,
					observeTruncate(pick(r, "reason"), 50),
				})
			}
			output.Table([]string{"at", "status", "strategy", "image", "replicas", "by", "reason"}, rows)
			return nil
		},
	}
	c.Flags().IntVar(&limit, "limit", 20, "how many releases to show")
	return c
}
