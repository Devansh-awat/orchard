package api

import (
	"errors"
	"net/url"
	"os/exec"
	"runtime"
	"strings"
)

func browsableURL(raw string) (string, error) {
	for _, r := range raw {
		if r <= 0x20 || r == 0x7f || (r >= 0x80 && r < 0xa0) {
			return "", errors.New("refusing to open a url with control characters or spaces")
		}
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || strings.HasPrefix(raw, "-") {
		return "", errors.New("refusing to open a url that is not http or https")
	}
	return u.String(), nil
}

// OpenBrowser best-effort opens url in the user's default browser.
func OpenBrowser(target string) error {
	url, err := browsableURL(target)
	if err != nil {
		return err
	}
	var cmd string
	var args []string
	switch runtime.GOOS {
	case "darwin":
		cmd = "open"
		args = []string{url}
	case "windows":
		cmd = "rundll32"
		args = []string{"url.dll,FileProtocolHandler", url}
	default: // linux, bsd, ...
		cmd = "xdg-open"
		args = []string{url}
	}
	return exec.Command(cmd, args...).Start()
}
