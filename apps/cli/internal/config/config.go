package config

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

const DefaultAPIURL = "https://orchard.infra.hackclub.com"

type Config struct {
	APIURL string `json:"apiUrl"`
	Token  string `json:"token"`
}

func dir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".orchard"), nil
}

func path() (string, error) {
	d, err := dir()
	if err != nil {
		return "", err
	}
	return filepath.Join(d, "config.json"), nil
}

func Load() (*Config, error) {
	c := &Config{APIURL: DefaultAPIURL}

	p, err := path()
	if err == nil {
		if data, rerr := os.ReadFile(p); rerr == nil {
			_ = json.Unmarshal(data, c)
		}
	}

	if v := os.Getenv("ORCHARD_API_URL"); v != "" {
		c.APIURL = v
	}
	if v := os.Getenv("ORCHARD_API_TOKEN"); v != "" {
		c.Token = v
	}
	if c.APIURL == "" {
		c.APIURL = DefaultAPIURL
	}
	return c, nil
}

func (c *Config) Save() error {
	d, err := dir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(d, 0o700); err != nil {
		return err
	}
	p := filepath.Join(d, "config.json")
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(p, data, 0o600)
}

func (c *Config) RequireToken() error {
	if c.Token == "" {
		return errors.New("not logged in: run `orchard auth login` or set ORCHARD_API_TOKEN")
	}
	return nil
}
