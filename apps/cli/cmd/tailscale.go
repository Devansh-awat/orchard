package cmd

import (
	"bufio"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"

	"github.com/hackclub/orchard/cli/internal/output"
	"github.com/spf13/cobra"
	"golang.org/x/term"
)

func tailscaleCmd() *cobra.Command {
	c := &cobra.Command{
		Use:     "tailscale",
		GroupID: groupUtility,
		Aliases: []string{"ts"},
		Short:   "Expose deployments on your Tailscale network",
	}
	c.AddCommand(
		tailscaleStatusCmd(),
		tailscaleLinkCmd(),
		tailscaleUnlinkCmd(),
		tailscaleGetCmd(),
		tailscaleExposeCmd(),
		tailscaleUnexposeCmd(),
	)
	return c
}

func tailscaleStatusCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "status",
		Short: "Show whether a Tailscale account is linked",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw map[string]any
			if err := cl.GetJSON(cmd.Context(), "/tailscale/status", &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			pairs := [][2]string{{"linked", pick(raw, "linked")}}
			if v := pick(raw, "tailnet"); v != "" {
				pairs = append(pairs, [2]string{"tailnet", v})
			}
			output.KV(pairs)
			return nil
		},
	}
}

func tailscaleLinkCmd() *cobra.Command {
	var authKey string
	c := &cobra.Command{
		Use:   "link",
		Short: "Link your Tailscale account with an auth key",
		Long: "Link Orchard to your tailnet with a Tailscale auth key.\n\n" +
			"Create one under Tailscale Admin → Settings → Keys: make it Reusable and\n" +
			"Ephemeral, leave Tags empty. The key is sensitive; pass it with --auth-key,\n" +
			"set ORCHARD_TS_AUTHKEY, or let the command prompt for it on stdin.",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			key, err := tailscaleAuthKey(cmd, authKey)
			if err != nil {
				return err
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPost, "/tailscale/link", map[string]any{"apiKey": key}, &raw); err != nil {
				return err
			}
			output.Successf("linked Tailscale account")
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			return nil
		},
	}
	c.Flags().StringVar(&authKey, "auth-key", "", "Tailscale auth key (tskey-auth-…); falls back to ORCHARD_TS_AUTHKEY or a stdin prompt")
	return c
}

// tailscaleAuthKey resolves the sensitive auth key: --auth-key flag, then the
// ORCHARD_TS_AUTHKEY env var, then stdin (prompting only when interactive).
func tailscaleAuthKey(cmd *cobra.Command, flag string) (string, error) {
	key := strings.TrimSpace(flag)
	if key == "" {
		key = strings.TrimSpace(os.Getenv("ORCHARD_TS_AUTHKEY"))
	}
	if key == "" {
		if term.IsTerminal(int(os.Stdin.Fd())) {
			fmt.Fprint(os.Stderr, "Paste your Tailscale auth key (tskey-auth-…): ")
		}
		r := bufio.NewReader(cmd.InOrStdin())
		line, _ := r.ReadString('\n')
		key = strings.TrimSpace(line)
	}
	if key == "" {
		return "", errors.New("no auth key: pass --auth-key, set ORCHARD_TS_AUTHKEY, or pipe the key on stdin")
	}
	if !strings.HasPrefix(key, "tskey-") {
		output.Warnf("auth key does not start with tskey- (continuing anyway)")
	}
	return key, nil
}

func tailscaleUnlinkCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "unlink",
		Short: "Unlink your Tailscale account",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := output.Confirm("unlink your Tailscale account (exposed deployments lose their tailnet address)", yesFlag); err != nil {
				return err
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			if err := cl.Send(cmd.Context(), http.MethodDelete, "/tailscale/unlink", nil, nil); err != nil {
				return err
			}
			output.Successf("unlinked Tailscale account")
			return nil
		},
	}
}

func tailscaleGetCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "get <deploymentId>",
		Short: "Show a deployment's Tailscale exposure",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw map[string]any
			if err := cl.GetJSON(cmd.Context(), "/tailscale/deployment/"+url.PathEscape(args[0]), &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			pairs := [][2]string{{"exposed", pick(raw, "exposed")}}
			for _, opt := range [][2]string{
				{"hostname", pick(raw, "hostname")},
				{"ip", pick(raw, "ip")},
				{"dns", pick(raw, "dns")},
			} {
				if opt[1] != "" {
					pairs = append(pairs, opt)
				}
			}
			output.KV(pairs)
			return nil
		},
	}
}

func tailscaleExposeCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "expose <deploymentId>",
		Short: "Expose a deployment on your tailnet via a sidecar",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPost, "/tailscale/expose/"+url.PathEscape(args[0]), nil, &raw); err != nil {
				return err
			}
			output.Successf("exposed %s on Tailscale as %s", args[0], pick(raw, "hostname"))
			output.Warnf("sidecar is starting; run `orchard tailscale get %s` for the address", args[0])
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			return nil
		},
	}
}

func tailscaleUnexposeCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "unexpose <deploymentId>",
		Short: "Remove a deployment's Tailscale exposure",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			if err := cl.Send(cmd.Context(), http.MethodPost, "/tailscale/unexpose/"+url.PathEscape(args[0]), nil, nil); err != nil {
				return err
			}
			output.Successf("removed Tailscale exposure from %s", args[0])
			return nil
		},
	}
}
