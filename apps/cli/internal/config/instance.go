package config

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
)

func NormalizeAPIURL(raw string) (string, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "", errors.New("enter the URL of your Orchard instance, like https://orchard.example.com")
	}
	if !strings.Contains(s, "://") {
		s = schemeFor(s) + "://" + s
	}
	u, err := url.Parse(s)
	if err != nil {
		return "", fmt.Errorf("invalid Orchard URL %q: use a URL like https://orchard.example.com", raw)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", fmt.Errorf("invalid Orchard URL %q: use an http:// or https:// URL", raw)
	}
	if u.Hostname() == "" {
		return "", fmt.Errorf("invalid Orchard URL %q: it has no hostname", raw)
	}
	if u.User != nil {
		return "", fmt.Errorf("invalid Orchard URL %q: remove the username and password", raw)
	}
	if port := u.Port(); port != "" {
		if n, perr := strconv.Atoi(port); perr != nil || n < 1 || n > 65535 {
			return "", fmt.Errorf("invalid Orchard URL %q: port %s is out of range", raw, port)
		}
	}
	host := strings.ToLower(u.Host)
	if (u.Scheme == "https" && u.Port() == "443") || (u.Scheme == "http" && u.Port() == "80") {
		host = strings.TrimSuffix(host, ":"+u.Port())
	}
	base := u.Scheme + "://" + host
	path := strings.TrimSuffix(strings.TrimRight(u.Path, "/"), "/apiv1")
	if strings.Trim(path, "/") != "" || u.RawQuery != "" || u.Fragment != "" {
		return "", fmt.Errorf("invalid Orchard URL %q: use the instance's base URL, like %s", raw, base)
	}
	return base, nil
}

func IsLoopback(apiURL string) bool {
	u, err := url.Parse(apiURL)
	if err != nil {
		return false
	}
	return isLoopbackHost(u.Hostname())
}

func schemeFor(s string) string {
	host := s
	if i := strings.IndexAny(host, "/?#"); i >= 0 {
		host = host[:i]
	}
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	if isLoopbackHost(strings.Trim(host, "[]")) {
		return "http"
	}
	return "https"
}

func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") || strings.HasSuffix(strings.ToLower(host), ".localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func sameURL(a, b string) bool {
	return strings.EqualFold(strings.TrimRight(a, "/"), strings.TrimRight(b, "/"))
}
