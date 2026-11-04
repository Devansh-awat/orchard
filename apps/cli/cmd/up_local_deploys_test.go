package cmd

import (
	"errors"
	"strings"
	"testing"

	"github.com/hackclub/orchard/cli/internal/api"
)

func TestLocalDeploysHintExplainsDisabledServer(t *testing.T) {
	err := localDeploysHint(&api.APIError{
		Status:  400,
		Message: "Local deploys are disabled on this server (set LOCAL_DEPLOYS_ENABLED=true and configure R2_BUILD_CONTEXT_BUCKET)",
	})
	if !strings.Contains(err.Error(), "orchard up is off on this server") {
		t.Errorf("error = %q, want the hint", err)
	}
	var apiErr *api.APIError
	if !errors.As(err, &apiErr) || apiErr.Status != 400 {
		t.Errorf("error %v lost the API error, so the exit code would change", err)
	}
}

func TestLocalDeploysHintPointsAtImportWhenS3IsMissing(t *testing.T) {
	err := localDeploysHint(&api.APIError{
		Status:  400,
		Message: "Local deploys need S3 storage. Add it under Instance admin, or run: sudo orchardctl backups s3 set",
	})
	if !strings.Contains(err.Error(), "orchard import owner/repo") {
		t.Errorf("error = %q, want the import hint", err)
	}
	var apiErr *api.APIError
	if !errors.As(err, &apiErr) || apiErr.Status != 400 {
		t.Errorf("error %v lost the API error, so the exit code would change", err)
	}
}

func TestLocalDeploysHintLeavesOtherErrorsAlone(t *testing.T) {
	want := &api.APIError{Status: 403, Message: "forbidden"}
	if got := localDeploysHint(want); got != error(want) {
		t.Errorf("error = %v, want it unchanged", got)
	}
	plain := errors.New("network down")
	if got := localDeploysHint(plain); got != plain {
		t.Errorf("error = %v, want it unchanged", got)
	}
}

func TestFinalBaseImage(t *testing.T) {
	cases := map[string]string{
		"FROM nginx:1.27\nCOPY . /usr/share/nginx/html\n":        "nginx:1.27",
		"FROM node:22 AS build\nRUN x\nFROM nginx AS web\n":      "nginx",
		"FROM nginx AS base\nFROM node:22 AS build\nfrom base\n": "nginx",
		"FROM --platform=linux/amd64 caddy:2\n":                  "caddy:2",
		"ARG TAG=1\nFROM nginx:$TAG\n":                           "",
		"FROM golang AS build\nFROM scratch\n":                   "",
		"# no stages\n":                                          "",
	}
	for in, want := range cases {
		if got := finalBaseImage(in); got != want {
			t.Errorf("finalBaseImage(%q) = %q, want %q", in, got, want)
		}
	}
}
