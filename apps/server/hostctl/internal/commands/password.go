package commands

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"strings"

	"github.com/hackclub/orchard/orchardctl/internal/cli"
)

const minPasswordLength = 12

// A password on the superadmin account, for instances that have no other way
// in: no SMTP to mail a code to, no identity provider, and no TLS, which
// passkeys require. It is set here rather than in the dashboard because root
// on this box already owns the instance, so this is also the reset flow.
func Password() *cli.Command {
	return &cli.Command{
		Name:    "password",
		Args:    "set|clear [--email <address>]",
		Summary: "a password for the superadmin account",
		Root:    true,
		Usage: `orchardctl password - a password for the superadmin account

  orchardctl password set     prompt for one and set it
  orchardctl password clear   remove it

Orchard signs people in with an email code, a passkey or an identity provider.
An instance with none of those has no way back in once its claim link is
spent, which is what this is for. It applies to the superadmin only, there is
no self-service and no reset email: setting it again here is how you reset it.

The password is typed, never passed as an argument, so it stays out of the
shell history and the process list. With more than one superadmin, name the
one you mean with --email.

On an instance served over plain HTTP the password crosses the network in the
clear on every sign-in. Over Tailscale or a VPN that is WireGuard's problem
rather than yours; on an untrusted LAN, prefer orchardctl login, whose link
cannot be reused once spent.
`,
		Run: func(c *cli.Context, args []string) error {
			args, apply := splitApply(args)
			_ = apply

			email, err := flagValue(args, "--email")
			if err != nil {
				return err
			}

			action := ""
			if len(args) > 0 {
				action = args[0]
			}

			script := []string{"exec", "-i", "deploy/server", "--", "node", "dist/scripts/set-password.js"}
			if email != "" {
				script = append(script, "--email", email)
			}

			switch action {
			case "set":
				// One reader for both prompts: a second bufio.Reader would
				// discard anything the first had already buffered, which is
				// every character of a pasted password.
				in := bufio.NewReader(os.Stdin)
				restore := echoOff()
				password, err := readSecret(c, in, "New password: ")
				if err != nil {
					restore()
					return err
				}
				if len(password) < minPasswordLength {
					restore()
					return fmt.Errorf("a password needs at least %d characters", minPasswordLength)
				}
				again, err := readSecret(c, in, "Again: ")
				restore()
				if err != nil {
					return err
				}
				if password != again {
					return fmt.Errorf("those did not match")
				}
				if err := c.RunWithInput(password, "kubectl",
					append([]string{"-n", c.Env.Namespace}, script...)...); err != nil {
					return err
				}
				c.Printf("Sign in at the dashboard with that address and password.\n")
				return nil

			case "clear":
				return c.Kubectl(append(script, "--clear")...)

			default:
				return fmt.Errorf("usage: orchardctl password set|clear [--email <address>]")
			}
		},
	}
}

// echoOff silences the terminal before anything is prompted for, not after:
// characters typed between the prompt and the switch are echoed by the tty
// driver, and a password pasted in one go arrives faster than any window.
// stty rather than a terminal library, because this binary carries no
// dependencies and ships inside the server image.
func echoOff() func() {
	stty, err := exec.LookPath("stty")
	if err != nil {
		return func() {}
	}
	off := exec.Command(stty, "-echo")
	off.Stdin = os.Stdin
	if off.Run() != nil {
		return func() {}
	}
	return func() {
		on := exec.Command(stty, "echo")
		on.Stdin = os.Stdin
		_ = on.Run()
	}
}

func readSecret(c *cli.Context, in *bufio.Reader, prompt string) (string, error) {
	c.Printf("%s", prompt)
	line, err := in.ReadString('\n')
	c.Printf("\n")
	if err != nil && line == "" {
		return "", fmt.Errorf("could not read the password")
	}
	return strings.TrimRight(line, "\r\n"), nil
}

func Login() *cli.Command {
	return &cli.Command{
		Name:    "login",
		Args:    "[--email <address>] [--url <address>]",
		Summary: "print a one-time link that signs you in",
		Root:    true,
		Usage: `orchardctl login - sign in from this box

Prints a link that signs you in as the superadmin, or as --email if you name
someone else. It is the same one-time code the email flow sends, minted here
and printed instead of mailed, so an instance with no SMTP configured still
has a way in. It expires in ten minutes and works once.

Reaching this command means having root on the box, which is already
ownership of the instance, so it grants nothing that was not already yours.

  orchardctl login
  orchardctl login --email me@example.com
  orchardctl login --url mango

--url overrides the address the link is built with, for a box reachable at a
name other than the one it generates links with. It has to be a name Traefik
answers on: orchardctl hostname.
`,
		Run: func(c *cli.Context, args []string) error {
			email, err := flagValue(args, "--email")
			if err != nil {
				return err
			}
			rawURL, err := flagValue(args, "--url")
			if err != nil {
				return err
			}

			script := []string{"exec", "deploy/server", "--", "node", "dist/scripts/mint-login-link.js"}
			if email != "" {
				script = append(script, "--email", email)
			}
			if rawURL != "" {
				values, err := cli.LoadValues(c.Env.Values)
				if err != nil {
					return err
				}
				base, err := claimBase(values, rawURL)
				if err != nil {
					return err
				}
				script = append(script, "--url", base)
			}
			return c.Kubectl(script...)
		},
	}
}
