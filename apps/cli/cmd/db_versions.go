package cmd

import (
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/hackclub/orchard/cli/internal/output"
	"github.com/spf13/cobra"
)

func dbSupportedLabel(v any) string {
	b, ok := v.(bool)
	switch {
	case !ok:
		return "unknown"
	case b:
		return "yes"
	}
	return "no"
}

func dbVersionsCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "versions",
		Short: "List the Postgres major versions you can create or upgrade to",
		Long: `List the Postgres majors on offer. They come from the CloudNativePG image catalog,
so a new major shows up here without an Orchard release. Pass a major to
` + "`orchard db create --pg-major`" + ` or ` + "`orchard db upgrade --to`" + `.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw map[string]any
			if err := cl.GetJSON(cmd.Context(), "/database-versions", &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			def := pick(raw, "defaultMajor")
			rows := [][]string{}
			for _, v := range asList(raw["versions"]) {
				major := pick(v, "major")
				marker := ""
				if major != "" && major == def {
					marker = "default"
				}
				rows = append(rows, []string{
					major,
					dbVersionMinor(v),
					dbSupportedLabel(v["supported"]),
					dbOr(pick(v, "eolDate"), "-"),
					marker,
				})
			}
			output.Table([]string{"major", "minor", "supported", "eol", ""}, rows)
			parts := []string{}
			if src := pick(raw, "source"); src != "" {
				parts = append(parts, "source "+src)
			}
			if at := pick(raw, "catalogDate"); at != "" {
				parts = append(parts, "catalog "+at)
			}
			if len(parts) > 0 {
				fmt.Println(output.Dim(strings.Join(parts, ", ")))
			}
			return nil
		},
	}
}

func dbVersionMinor(v map[string]any) string {
	minor := pick(v, "minor")
	if minor == "" {
		return "-"
	}
	if major := pick(v, "major"); major != "" && !strings.Contains(minor, ".") {
		return major + "." + minor
	}
	return minor
}

func dbVersionLess(a, b string) bool {
	pa, pb := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < len(pa) || i < len(pb); i++ {
		var x, y int
		if i < len(pa) {
			x, _ = strconv.Atoi(pa[i])
		}
		if i < len(pb) {
			y, _ = strconv.Atoi(pb[i])
		}
		if x != y {
			return x < y
		}
	}
	return false
}

func dbScore(v map[string]any) float64 {
	f, _ := v["score"].(float64)
	return f
}

func dbFixLabel(vuln map[string]any, auto map[string]any) string {
	fixed := pick(vuln, "fixedInVersion")
	if fixed == "" {
		return "no fix on this major"
	}
	if to := pick(auto, "to"); to != "" && !dbVersionLess(to, fixed) {
		if b, _ := auto["automatic"].(bool); b {
			return "automatic minor update"
		}
		return "minor update"
	}
	return "upgrade needed"
}

func dbSecurityCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "security <dbId>",
		Short: "Show the running Postgres version, known CVEs and what fixes them",
		Long: `Show the Postgres version a database runs, the CVEs published for it (from the
postgresql.org security advisories, refreshed twice a day) and what to do.

Orchard rolls minor versions on its own, so a CVE fixed in a newer minor of the same
major goes away without action. A CVE with no fix on the running major needs
` + "`orchard db upgrade`" + `.

The exit code is 0 whatever the findings: no exit code means "vulnerable", and exit 1
would look like a network error. Scripts can branch on the JSON instead, for example:
  orchard db security <id> -o json | jq -e '.action != "major_upgrade"'`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw map[string]any
			if err := cl.GetJSON(cmd.Context(), "/databases/"+url.PathEscape(args[0])+"/security", &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			dbRenderSecurity(raw)
			return nil
		},
	}
}

func dbRenderSecurity(raw map[string]any) {
	auto, _ := raw["minorUpdate"].(map[string]any)
	running := dbOr(pick(raw, "running"), "unknown")
	if v := pick(raw, "latestMinor"); v != "" && v != running {
		running += " (latest " + v + ")"
	}
	support := dbSupportedLabel(raw["supported"])
	if eol := pick(raw, "eolDate"); eol != "" {
		support += ", end of life " + eol
	}
	if b, _ := raw["endOfLifeSoon"].(bool); b {
		support += " (soon)"
	}
	actions := map[string]string{
		"none":          "nothing to do",
		"minor_update":  "minor update",
		"major_upgrade": "major upgrade needed",
		"unknown":       "unknown (version or advisories not available)",
	}
	action := pick(raw, "action")
	pairs := [][2]string{
		{"running", running},
		{"supported", support},
		{"action", dbOr(actions[action], action)},
		{"highest score", pick(raw, "highestScore")},
		{"image", pick(raw, "image")},
		{"advisories from", pick(raw, "advisoriesFetchedAt")},
	}
	output.KV(dbTrimEmpty(pairs))
	vulns := asList(raw["vulnerabilities"])
	if len(vulns) > 0 {
		sort.SliceStable(vulns, func(i, j int) bool { return dbScore(vulns[i]) > dbScore(vulns[j]) })
		rows := [][]string{}
		for _, v := range vulns {
			rows = append(rows, []string{
				pick(v, "cve"),
				pick(v, "score"),
				dbOr(pick(v, "fixedInVersion"), "-"),
				dbFixLabel(v, auto),
				pick(v, "component"),
				dbOneLine(pick(v, "description"), 60),
			})
		}
		fmt.Println()
		output.Table([]string{"cve", "score", "fixed in", "fix", "component", "description"}, rows)
	} else {
		fmt.Println()
		fmt.Println(output.Dim("no known vulnerabilities for this version"))
	}
	fmt.Println()
	if to := pick(auto, "to"); to != "" {
		if b, _ := auto["automatic"].(bool); b {
			fmt.Printf("minor update to %s happens automatically\n", to)
		} else {
			fmt.Printf("minor update to %s is available\n", to)
		}
	}
	ups := []string{}
	for _, u := range asList(raw["upgrades"]) {
		label := pick(u, "major")
		if dbSupportedLabel(u["supported"]) == "no" {
			label += " (unsupported)"
		}
		ups = append(ups, label)
	}
	if len(ups) > 0 {
		fmt.Printf("major upgrades available: %s (`orchard db upgrade <id> --to <major>`)\n", strings.Join(ups, ", "))
	}
}

func dbUpgradeCmd() *cobra.Command {
	var (
		to          int
		noRehearse  bool
		wait        *bool
		timeoutFlag *time.Duration
	)
	c := &cobra.Command{
		Use:   "upgrade <dbId>",
		Short: "Upgrade a database to a newer Postgres major version",
		Long: `Upgrade a database to a newer Postgres major (see ` + "`orchard db versions`" + `).

First a rehearsal runs pg_upgrade on a live copy, so a problem shows up before the real
database is touched. Then Orchard takes a checkpoint and upgrades in place: Postgres is
offline during that step, usually a minute or two for small databases (the rehearsal's
result.rehearsal.upgradeMs estimates it). If the real upgrade fails, the database is
reverted to the old version. --no-rehearse skips the rehearsal.

The command prints the operation id. --wait follows its phases until it succeeds or fails.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			rehearsal := "a rehearsal on a copy runs first"
			if noRehearse {
				rehearsal = "no rehearsal runs first (--no-rehearse)"
			}
			prompt := fmt.Sprintf("upgrade database %s to Postgres %d: %s, then Postgres goes OFFLINE during the upgrade (usually a minute or two); a failed upgrade is reverted to the old version", args[0], to, rehearsal)
			if err := output.Confirm(prompt, yesFlag); err != nil {
				return err
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			body := map[string]any{"major": to, "rehearse": !noRehearse}
			var op map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPost, "/databases/"+url.PathEscape(args[0])+"/upgrade", body, &op); err != nil {
				return err
			}
			return dbFinishOperation(cmd.Context(), cl, op, "upgrade", *wait, *timeoutFlag)
		},
	}
	c.Flags().IntVar(&to, "to", 0, "target Postgres major, as listed by orchard db versions (required)")
	c.Flags().BoolVar(&noRehearse, "no-rehearse", false, "skip the rehearsal on a copy")
	_ = c.MarkFlagRequired("to")
	wait, timeoutFlag = addWaitFlags(c)
	return c
}
