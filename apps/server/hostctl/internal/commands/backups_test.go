package commands

import (
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/hackclub/orchard/orchardctl/internal/cli"
)

func storageContext(t *testing.T) (*cli.Context, func() string) {
	t.Helper()
	stderr, err := os.CreateTemp(t.TempDir(), "stderr")
	if err != nil {
		t.Fatal(err)
	}
	return &cli.Context{Stdout: stderr, Stderr: stderr}, func() string {
		raw, _ := os.ReadFile(stderr.Name())
		return string(raw)
	}
}

func noEnv(string) string { return "" }

func noFile(string) ([]byte, error) { return nil, errors.New("no file") }

func TestStorageInputUsesOneBucketForEverything(t *testing.T) {
	c, _ := storageContext(t)
	input, err := collectStorageInput(c, []string{
		"--endpoint", "https://s3.eu-west-1.amazonaws.com",
		"--bucket", "mine",
		"--region", "eu-west-1",
		"--path-style", "false",
		"--access-key", "AK",
		"--secret-key-file", "/secret",
	}, noEnv, func(string) ([]byte, error) { return []byte("from-file\n"), nil }, nil)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"endpoint":        "https://s3.eu-west-1.amazonaws.com",
		"backupBucket":    "mine",
		"bucketName":      "mine",
		"region":          "eu-west-1",
		"pathStyle":       "false",
		"accessKeyId":     "AK",
		"secretAccessKey": "from-file",
	}
	for k, v := range want {
		if input[k] != v {
			t.Errorf("%s = %q, want %q", k, input[k], v)
		}
	}
}

func TestStorageSecretFromEnvDoesNotWarnOrPrompt(t *testing.T) {
	c, output := storageContext(t)
	env := func(name string) string {
		return map[string]string{"ORCHARD_S3_ACCESS_KEY": "AK", "ORCHARD_S3_SECRET_KEY": "SK"}[name]
	}
	input, err := collectStorageInput(c, nil, env, noFile, func() (string, error) {
		t.Fatal("must not prompt when the environment has the secret")
		return "", nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if input["accessKeyId"] != "AK" || input["secretAccessKey"] != "SK" {
		t.Fatalf("input %v", input)
	}
	if output() != "" {
		t.Fatalf("unexpected output %q", output())
	}
}

func TestStorageSecretOnTheCommandLineWarnsAboutHistory(t *testing.T) {
	c, output := storageContext(t)
	input, err := collectStorageInput(c, []string{"--access-key", "AK", "--secret-key", "SK"}, noEnv, noFile, nil)
	if err != nil {
		t.Fatal(err)
	}
	if input["secretAccessKey"] != "SK" {
		t.Fatalf("input %v", input)
	}
	if !strings.Contains(output(), "shell history") {
		t.Fatalf("output %q, want the warning", output())
	}
	if strings.Contains(output(), "SK") {
		t.Fatal("the warning must not print the secret")
	}
}

func TestStorageInputRefusesABadPathStyle(t *testing.T) {
	c, _ := storageContext(t)
	if _, err := collectStorageInput(c, []string{"--path-style", "maybe"}, noEnv, noFile, nil); err == nil {
		t.Fatal("want an error")
	}
}

func TestUploadsBucketIsSeparateFromBackups(t *testing.T) {
	c, _ := storageContext(t)
	input, err := collectStorageInput(c, []string{
		"--bucket", "backups", "--uploads-bucket", "public", "--public-url", "https://cdn.example.com",
	}, noEnv, noFile, nil)
	if err != nil {
		t.Fatal(err)
	}
	if input["backupBucket"] != "backups" || input["bucketName"] != "public" || input["publicUrl"] != "https://cdn.example.com" {
		t.Fatalf("input %v", input)
	}
}

func TestStorageTestResultCarriesTheServersMessage(t *testing.T) {
	if err := storageTestResult(`{"ok":true}`); err != nil {
		t.Fatal(err)
	}
	err := storageTestResult(`{"ok":false,"message":"The bucket x does not exist."}`)
	if err == nil || !strings.Contains(err.Error(), "does not exist") {
		t.Fatalf("err %v", err)
	}
	if storageTestResult("not json") == nil {
		t.Fatal("want an error")
	}
}

func TestStorageStatusSaysWhereBackupsAre(t *testing.T) {
	local := formatStorageStatus(`{"configured":false,"localStore":true,"lockedFields":[]}`)
	if !strings.Contains(local, "Backups are on this server. If you lose the server, you lose the backups.") {
		t.Errorf("local: %q", local)
	}
	s3 := formatStorageStatus(`{"configured":true,"endpoint":"https://x","bucket":"b","region":"eu","pathStyle":"false","lockedFields":["endpoint"]}`)
	if !strings.Contains(s3, "https://x, bucket b, region eu, bucket in the hostname") || !strings.Contains(s3, "endpoint") {
		t.Errorf("s3: %q", s3)
	}
	none := formatStorageStatus(`{"configured":false,"localStore":false}`)
	if !strings.Contains(none, "no backups") {
		t.Errorf("none: %q", none)
	}
}
