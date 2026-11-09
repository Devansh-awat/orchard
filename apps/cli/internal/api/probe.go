package api

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"syscall"
	"time"
)

const probeTimeout = 10 * time.Second

func ProbeInstance(ctx context.Context, baseURL string) (string, error) {
	base := strings.TrimRight(baseURL, "/")
	target, err := probeOnce(ctx, base)
	if err != nil || target == nil {
		return base, err
	}
	upgraded := httpsUpgrade(base, target)
	if upgraded == "" {
		return "", fmt.Errorf("%s redirects to %s://%s: enter that address instead", base, target.Scheme, target.Host)
	}
	again, err := probeOnce(ctx, upgraded)
	if err != nil {
		return "", err
	}
	if again != nil {
		return "", fmt.Errorf("%s redirects to %s://%s: enter that address instead", upgraded, again.Scheme, again.Host)
	}
	return upgraded, nil
}

func httpsUpgrade(base string, target *url.URL) string {
	from, err := url.Parse(base)
	if err != nil || from.Scheme != "http" || target.Scheme != "https" || !strings.EqualFold(from.Hostname(), target.Hostname()) {
		return ""
	}
	return "https://" + strings.TrimSuffix(strings.ToLower(target.Host), ":443")
}

func probeOnce(ctx context.Context, base string) (*url.URL, error) {
	ctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/apiv1/health", nil)
	if err != nil {
		return nil, fmt.Errorf("invalid Orchard URL %q: %w", base, err)
	}
	req.Header.Set("Accept", "application/json")
	httpClient := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}
	res, err := httpClient.Do(req)
	if err != nil {
		return nil, describeProbeError(base, err)
	}
	defer res.Body.Close()
	switch {
	case res.StatusCode >= 300 && res.StatusCode < 400:
		target, lerr := res.Location()
		if lerr != nil {
			return nil, notOrchard(base, fmt.Sprintf("it answered HTTP %d", res.StatusCode))
		}
		return target, nil
	case res.StatusCode >= 500:
		return nil, fmt.Errorf("%s answered HTTP %d: the instance may be down or still starting, so try again shortly", base, res.StatusCode)
	case res.StatusCode != http.StatusOK:
		return nil, notOrchard(base, fmt.Sprintf("it answered HTTP %d", res.StatusCode))
	}
	var health struct {
		Status  string `json:"status"`
		Version string `json:"version"`
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, 64*1024))
	if err != nil {
		return nil, describeProbeError(base, err)
	}
	if json.Unmarshal(body, &health) != nil || health.Status != "ok" || health.Version == "" {
		return nil, notOrchard(base, "its health check isn't Orchard's")
	}
	return nil, nil
}

func notOrchard(base, why string) error {
	return fmt.Errorf("%s doesn't look like an Orchard instance: %s. Check the URL", base, why)
}

func describeProbeError(base string, err error) error {
	var (
		netErr     net.Error
		dnsErr     *net.DNSError
		unknownCA  x509.UnknownAuthorityError
		hostname   x509.HostnameError
		invalid    x509.CertificateInvalidError
		verify     *tls.CertificateVerificationError
		recordHead tls.RecordHeaderError
	)
	switch {
	case errors.Is(err, context.Canceled):
		return err
	case errors.As(err, &unknownCA), errors.As(err, &hostname), errors.As(err, &invalid), errors.As(err, &verify):
		return fmt.Errorf("couldn't verify the TLS certificate of %s: %w", base, err)
	case errors.As(err, &recordHead), errors.Is(err, http.ErrSchemeMismatch):
		return fmt.Errorf("%s isn't serving TLS: if it only serves plain HTTP, enter an http:// URL", base)
	case errors.As(err, &dnsErr):
		return fmt.Errorf("couldn't reach %s: that hostname doesn't resolve, so check the URL", base)
	case errors.Is(err, syscall.ECONNREFUSED):
		return fmt.Errorf("couldn't reach %s: connection refused, so check the URL and port and that the instance is running", base)
	case errors.As(err, &netErr) && netErr.Timeout():
		return fmt.Errorf("couldn't reach %s: no answer within %s, so check the URL and your network", base, probeTimeout)
	}
	return fmt.Errorf("couldn't reach %s: %w", base, err)
}
