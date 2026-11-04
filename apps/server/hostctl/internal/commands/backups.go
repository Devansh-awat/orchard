package commands

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/hackclub/orchard/orchardctl/internal/cli"
)

const storageScript = "dist/scripts/storage-config.js"

const storageAppliesTo = `Saved. The server picks this up within 30 seconds.
New databases back up here. Databases you already have keep backing up to where
they are now, and their existing backups stay restorable from there.
`

func storageExec(command string) []string {
	return []string{"exec", "-i", "deploy/server", "-c", "server", "--", "node", storageScript, command}
}

func Backups() *cli.Command {
	return &cli.Command{
		Name:    "backups",
		Args:    "s3 <status|test|set|clear>",
		Summary: "show or change the S3 storage for backups and uploads",
		Root:    true,
		Usage: `orchardctl backups s3 - S3 storage for backups and uploads

  orchardctl backups s3 status
  orchardctl backups s3 test  [flags]
  orchardctl backups s3 set   [flags]
  orchardctl backups s3 clear

Flags for test and set:

  --endpoint <url>          for example https://s3.eu-west-1.amazonaws.com
  --bucket <name>           holds backups, uploads and build contexts
  --region <name>           default: auto
  --path-style <true|false> false for <bucket>.<endpoint> (default: true)
  --access-key <id>         or ORCHARD_S3_ACCESS_KEY
  --secret-key-file <path>  or ORCHARD_S3_SECRET_KEY, or typed at a prompt
  --secret-key <secret>     works, but stays in your shell history
  --public-url <url>        serve uploads from here, with a separate bucket
  --uploads-bucket <name>   the separate bucket for that public URL
  --skip-test               save without testing the connection

set tests the connection first and saves nothing if the test fails.

Changing storage applies to new databases. Databases you already have keep
backing up to where they are now, and their existing backups stay restorable
from there. clear goes back to the store on this server, if it has one.

Settings from R2_* environment variables win over these, and can't be changed
here. Refer to https://docs.orchard.my/operate/storage/
`,
		Run: func(c *cli.Context, args []string) error {
			if len(args) < 2 || args[0] != "s3" {
				return fmt.Errorf("usage: orchardctl backups s3 status|test|set|clear")
			}
			action, rest := args[1], args[2:]
			switch action {
			case "status":
				return runStorageStatus(c)
			case "clear":
				return c.Kubectl(storageExec("clear")...)
			case "test":
				input, err := collectStorageInput(c, rest, os.Getenv, os.ReadFile, promptStorageSecret(c))
				if err != nil {
					return err
				}
				if err := testStorage(c, input); err != nil {
					return err
				}
				c.Printf("Connection works: Orchard can list, write and delete in that bucket.\n")
				return nil
			case "set":
				input, err := collectStorageInput(c, rest, os.Getenv, os.ReadFile, promptStorageSecret(c))
				if err != nil {
					return err
				}
				if !containsFlag(rest, "--skip-test") {
					if err := testStorage(c, input); err != nil {
						return fmt.Errorf("%w\nNothing was saved", err)
					}
				}
				payload, err := json.Marshal(input)
				if err != nil {
					return err
				}
				exec := append([]string{"-n", c.Env.Namespace}, storageExec("set")...)
				if _, err := c.CaptureWithInput(string(payload), "kubectl", exec...); err != nil {
					return fmt.Errorf("couldn't save the settings: %w", err)
				}
				c.Printf("%s", storageAppliesTo)
				return nil
			default:
				return fmt.Errorf("usage: orchardctl backups s3 status|test|set|clear")
			}
		},
	}
}

func containsFlag(args []string, name string) bool {
	for _, a := range args {
		if a == name {
			return true
		}
	}
	return false
}

func promptStorageSecret(c *cli.Context) func() (string, error) {
	return func() (string, error) {
		in := bufio.NewReader(os.Stdin)
		restore := echoOff()
		defer restore()
		return readSecret(c, in, "Secret key: ")
	}
}

func collectStorageInput(
	c *cli.Context,
	args []string,
	getenv func(string) string,
	readFile func(string) ([]byte, error),
	prompt func() (string, error),
) (map[string]string, error) {
	input := map[string]string{}
	flags := map[string]string{
		"--endpoint":   "endpoint",
		"--region":     "region",
		"--public-url": "publicUrl",
	}
	for flag, field := range flags {
		value, err := flagValue(args, flag)
		if err != nil {
			return nil, err
		}
		if value != "" {
			input[field] = value
		}
	}
	bucket, err := flagValue(args, "--bucket")
	if err != nil {
		return nil, err
	}
	uploads, err := flagValue(args, "--uploads-bucket")
	if err != nil {
		return nil, err
	}
	if bucket != "" {
		input["backupBucket"] = bucket
		input["bucketName"] = bucket
	}
	if uploads != "" {
		input["bucketName"] = uploads
	}

	style, err := flagValue(args, "--path-style")
	if err != nil {
		return nil, err
	}
	switch style {
	case "":
		if containsFlag(args, "--endpoint") {
			input["pathStyle"] = "true"
		}
	case "true", "false":
		input["pathStyle"] = style
	default:
		return nil, fmt.Errorf("--path-style takes true or false")
	}

	access, err := flagValue(args, "--access-key")
	if err != nil {
		return nil, err
	}
	if access == "" {
		access = getenv("ORCHARD_S3_ACCESS_KEY")
	}
	if access != "" {
		input["accessKeyId"] = strings.TrimSpace(access)
	}

	secret, err := flagValue(args, "--secret-key")
	if err != nil {
		return nil, err
	}
	if secret != "" {
		c.Warnf("A secret on the command line stays in your shell history. Use --secret-key-file or ORCHARD_S3_SECRET_KEY next time.\n")
	}
	file, err := flagValue(args, "--secret-key-file")
	if err != nil {
		return nil, err
	}
	if file != "" {
		raw, err := readFile(file)
		if err != nil {
			return nil, fmt.Errorf("couldn't read %s: %w", file, err)
		}
		secret = string(raw)
	}
	if secret == "" {
		secret = getenv("ORCHARD_S3_SECRET_KEY")
	}
	if secret == "" && access != "" && prompt != nil {
		secret, err = prompt()
		if err != nil {
			return nil, err
		}
	}
	if secret = strings.TrimSpace(secret); secret != "" {
		input["secretAccessKey"] = secret
	}
	return input, nil
}

func testStorage(c *cli.Context, input map[string]string) error {
	payload, err := json.Marshal(input)
	if err != nil {
		return err
	}
	exec := append([]string{"-n", c.Env.Namespace}, storageExec("test")...)
	out, err := c.CaptureWithInput(string(payload), "kubectl", exec...)
	if err != nil {
		return fmt.Errorf("couldn't run the test on the server: %w", err)
	}
	return storageTestResult(out)
}

func storageTestResult(out string) error {
	var result struct {
		OK      bool   `json:"ok"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(out)), &result); err != nil {
		return fmt.Errorf("the server gave an unexpected answer to the connection test")
	}
	if !result.OK {
		return fmt.Errorf("%s", result.Message)
	}
	return nil
}

func runStorageStatus(c *cli.Context) error {
	out, err := c.KubectlOut(storageExec("status")...)
	if err != nil {
		return fmt.Errorf("couldn't read the settings: %w", err)
	}
	c.Printf("%s", formatStorageStatus(out))
	return nil
}

func formatStorageStatus(out string) string {
	var status struct {
		Configured   bool     `json:"configured"`
		Endpoint     string   `json:"endpoint"`
		Bucket       string   `json:"bucket"`
		Region       string   `json:"region"`
		PathStyle    string   `json:"pathStyle"`
		LockedFields []string `json:"lockedFields"`
		LocalStore   bool     `json:"localStore"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(out)), &status); err != nil {
		return "Couldn't read the status.\n"
	}
	var b strings.Builder
	switch {
	case status.Configured:
		fmt.Fprintf(&b, "S3 storage: %s, bucket %s, region %s", status.Endpoint, status.Bucket, envOr(status.Region, "auto"))
		if status.PathStyle == "false" {
			b.WriteString(", bucket in the hostname")
		}
		b.WriteString("\n")
	case status.LocalStore:
		b.WriteString("Backups are on this server. If you lose the server, you lose the backups.\n")
		b.WriteString("To add S3 storage: sudo orchardctl backups s3 set\n")
	default:
		b.WriteString("No storage is set, so managed databases have no backups.\n")
		b.WriteString("To add S3 storage: sudo orchardctl backups s3 set\n")
	}
	if len(status.LockedFields) > 0 {
		fmt.Fprintf(&b, "Set by R2_* environment variables, so you can't change them here: %s\n", strings.Join(status.LockedFields, ", "))
	}
	return b.String()
}
