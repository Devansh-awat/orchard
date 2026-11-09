package cmd

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/hackclub/orchard/cli/internal/api"
	"github.com/hackclub/orchard/cli/internal/config"
	"github.com/hackclub/orchard/cli/internal/output"
	"github.com/hackclub/orchard/cli/internal/tui"
)

var errNoInstance = errors.New("no Orchard instance configured: run `orchard auth login --api-url <url>` or set ORCHARD_API_URL")

var (
	canAskForInstance = terminalCanAsk
	askInstanceURL    = tui.AskInstanceURL
	browserLogin      = webLogin
)

func terminalCanAsk() bool {
	if ci := os.Getenv("CI"); ci != "" && ci != "0" && ci != "false" {
		return false
	}
	return output.StdinIsTTY() && output.IsTTY() && output.StderrIsTTY()
}

func verifyInstance(ctx context.Context, raw string) (string, error) {
	normalized, err := config.NormalizeAPIURL(raw)
	if err != nil {
		return "", err
	}
	return api.ProbeInstance(ctx, normalized)
}

func warnIfPlaintext(apiURL string) {
	if strings.HasPrefix(apiURL, "http://") && !config.IsLoopback(apiURL) {
		output.Warnf("%s is not https, so your token will travel in clear text", apiURL)
	}
}

func setupFirstInstance(ctx context.Context, cfg *config.Config, name string) (*config.Config, error) {
	if !canAskForInstance() {
		return nil, errNoInstance
	}
	if name != "" && !config.ValidName(name) {
		return nil, fmt.Errorf("invalid context name %q: use letters, numbers, dots, dashes or underscores", name)
	}
	apiURL, ok, err := askInstanceURL(ctx, verifyInstance)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, errors.New("aborted: no Orchard instance set up")
	}
	warnIfPlaintext(apiURL)
	next, err := cfg.ForInstance(apiURL, name)
	if err != nil {
		return nil, err
	}
	if err := next.Save(); err != nil {
		return nil, err
	}
	output.Successf("added context %s (%s)", next.Name, next.APIURL)
	if env := os.Getenv("ORCHARD_API_TOKEN"); env != "" {
		next.Token = env
	}
	return next, nil
}

func loginInstance(ctx context.Context, cfg *config.Config, flagURL, name string) (*config.Config, error) {
	target := flagURL
	if target == "" {
		target = os.Getenv("ORCHARD_API_URL")
	}
	if target != "" {
		return addInstance(ctx, cfg, target, name)
	}
	if !cfg.HasInstance() {
		return setupFirstInstance(ctx, cfg, name)
	}
	if name != "" {
		return cfg.ForInstance(cfg.APIURL, name)
	}
	return cfg, nil
}

func addInstance(ctx context.Context, cfg *config.Config, raw, name string) (*config.Config, error) {
	f, err := config.LoadFile()
	if err != nil {
		return nil, err
	}
	if _, known := f.FindByURL(raw); known {
		return cfg.ForInstance(raw, name)
	}
	normalized, err := config.NormalizeAPIURL(raw)
	if err != nil {
		return nil, err
	}
	if _, known := f.FindByURL(normalized); !known {
		if normalized, err = api.ProbeInstance(ctx, normalized); err != nil {
			return nil, err
		}
		warnIfPlaintext(normalized)
	}
	return cfg.ForInstance(normalized, name)
}

func instanceConfig(ctx context.Context) (*config.Config, error) {
	cfg, err := config.Load()
	if err != nil {
		return nil, err
	}
	if cfg.HasInstance() {
		return cfg, nil
	}
	return setupFirstInstance(ctx, cfg, "")
}

func signedInConfig(ctx context.Context) (*config.Config, error) {
	cfg, err := config.Load()
	if err != nil || cfg.HasInstance() {
		return cfg, err
	}
	if cfg, err = setupFirstInstance(ctx, cfg, ""); err != nil {
		return nil, err
	}
	if cfg.Token == "" {
		if err := browserLogin(cfg, cfg.APIURL, true); err != nil {
			return nil, err
		}
	}
	return cfg, nil
}
