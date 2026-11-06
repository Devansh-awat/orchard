package main

import (
	"context"
	"crypto/ed25519"
	"os"
	"strings"
	"time"
)

const defaultIndexTTL = 45 * 24 * time.Hour

func (p *publisher) stamp() (int64, string) {
	if p.signKey == nil {
		return 0, ""
	}
	ttl := p.indexTTL
	if ttl <= 0 {
		ttl = defaultIndexTTL
	}
	now := p.now().UTC()
	return now.Unix(), now.Add(ttl).Format(time.RFC3339)
}

func (p *publisher) putIndex(ctx context.Context, key string, body []byte) (bool, error) {
	changed, err := p.putIfChanged(ctx, key, body, "application/json; charset=utf-8", cacheIndex, false)
	if err != nil {
		return false, err
	}
	if p.signKey == nil {
		return changed, nil
	}
	if _, err := p.putIfChanged(ctx, key+".sig", signDetached(p.signKey, body), listingSigContentType, cacheIndex, false); err != nil {
		return changed, err
	}
	return changed, nil
}

func signingKeyFromEnv(logf func(format string, args ...any)) ed25519.PrivateKey {
	if strings.TrimSpace(os.Getenv("GRAFT_SIGNING_KEY")) == "" {
		logf("warning: GRAFT_SIGNING_KEY is not set, so the index is published unsigned and servers cannot verify it")
		return nil
	}
	key, err := parseSigningKey(os.Getenv("GRAFT_SIGNING_KEY"))
	if err != nil {
		logf("fatal: %v", err)
		os.Exit(1)
	}
	if !isOfficialKey(key.Public().(ed25519.PublicKey)) {
		logf("warning: GRAFT_SIGNING_KEY is not one of the Orchard keys servers trust, so they will reject the signed index")
	}
	return key
}
