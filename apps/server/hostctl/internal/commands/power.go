package commands

import (
	"fmt"
	"os/exec"
	"time"

	"github.com/hackclub/orchard/orchardctl/internal/cli"
)

// Everything Orchard runs is a pod, so there is nothing to stop above k3s and
// nothing below it worth leaving up. The service is the whole instance.
const k3sUnit = "k3s"

func systemd() error {
	if _, err := exec.LookPath("systemctl"); err != nil {
		return fmt.Errorf("no systemctl here, so k3s isn't a service on this server: stop it the way it was started")
	}
	return nil
}

func Stop() *cli.Command {
	return &cli.Command{
		Name:    "stop",
		Summary: "stop this instance until you start it again",
		Root:    true,
		Usage: `orchardctl stop - stop this instance

Stops k3s, which stops everything: the dashboard, the API, your databases and
every app deployed here. Nothing is deleted and nothing is lost, and disks stay
where they are.

Use this to take a server off the network for a while, or to free it up for
something else. To start it again, run orchardctl start or reboot.
`,
		Run: func(c *cli.Context, args []string) error {
			if err := systemd(); err != nil {
				return err
			}
			if err := c.Run("systemctl", "stop", k3sUnit); err != nil {
				return err
			}
			c.Printf("stopped. Nothing is lost.\n")
			c.Printf("  orchardctl start   bring it back\n")
			return nil
		},
	}
}

func Start() *cli.Command {
	return &cli.Command{
		Name:    "start",
		Summary: "start this instance back up",
		Root:    true,
		Usage: `orchardctl start - start this instance

Starts k3s and waits for the node to come back, which is when pods start
again. Apps start on their own, so you don't need to redeploy them.

A reboot does the same thing, so use this after orchardctl stop.
`,
		Run: func(c *cli.Context, args []string) error {
			if err := systemd(); err != nil {
				return err
			}
			if err := c.Run("systemctl", "start", k3sUnit); err != nil {
				return err
			}
			c.Printf("k3s started, waiting for the node\n")
			if err := waitForNode(c); err != nil {
				c.Warnf("%v\n", err)
				c.Warnf("It may still be coming up. Watch it with: orchardctl status\n")
				return nil
			}
			c.Printf("ready. Apps start on their own within about a minute.\n")
			return nil
		},
	}
}

func Restart() *cli.Command {
	return &cli.Command{
		Name:    "restart",
		Summary: "stop and start this instance",
		Root:    true,
		Usage: `orchardctl restart - stop and start this instance

This restarts k3s, not the Orchard pods. To restart only those, run
orchardctl update, which redeploys the chart and restarts what it needs to.
`,
		Run: func(c *cli.Context, args []string) error {
			if err := Stop().Run(c, nil); err != nil {
				return err
			}
			return Start().Run(c, nil)
		},
	}
}

// The API server is not listening the moment systemctl returns, so kubectl has
// to be retried before it is worth waiting on a condition.
func waitForNode(c *cli.Context) error {
	deadline := time.Now().Add(2 * time.Minute)
	for {
		if _, err := c.KubectlOut("get", "--raw", "/readyz"); err == nil {
			break
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("k3s didn't answer within two minutes")
		}
		time.Sleep(2 * time.Second)
	}
	if _, err := c.KubectlOut("wait", "--for=condition=Ready", "node", "--all", "--timeout=120s"); err != nil {
		return fmt.Errorf("the node didn't report Ready within two minutes")
	}
	return nil
}
