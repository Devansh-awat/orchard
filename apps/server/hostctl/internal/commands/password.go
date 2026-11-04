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
An instance with none of those has no way back in once its claim link is used.
Use this command in that case. There is no reset email, so to reset a password,
set it again here. On an instance with no email, --email can also name someone
who joined by invitation link.

You type the password at a prompt, so it stays out of the shell history and the
process list. With more than one superadmin, name the one you mean with --email.

On an instance served over plain HTTP, the password crosses the network
unencrypted on every sign-in. Tailscale or a VPN encrypts it. On an untrusted
LAN, use orchardctl login instead, because its link works only once.
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
					return fmt.Errorf("the passwords don't match")
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
		return "", fmt.Errorf("couldn't read the password")
	}
	return strings.TrimRight(line, "\r\n"), nil
}

func Login() *cli.Command {
	return &cli.Command{
		Name:    "login",
		Args:    "[--email <address>] [--url <address>]",
		Summary: "print a one-time link that signs you in",
		Root:    true,
		Usage: `orchardctl login - sign in from this server

Prints a link that signs you in as the superadmin, or as --email if you name
someone else. It uses the same one-time code as email sign-in, printed here instead of sent,
so an instance with no SMTP still has a way in. It expires in ten minutes and
works once.

This command needs root on the server, which already gives you full control of
the instance.

  orchardctl login
  orchardctl login --email me@example.com
  orchardctl login --url mango

--url overrides the address in the link, for a server you reach at a different
name. It must be a name Traefik answers on: orchardctl hostname.
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
