package commands

import (
	"reflect"
	"testing"
)

func TestTraefikChartVersion(t *testing.T) {
	version, major, ok := traefikChartVersion("traefik-41.5.0")
	if !ok || version != "41.5.0" || major != 41 {
		t.Fatalf("got %q %d %v", version, major, ok)
	}
	if _, _, ok := traefikChartVersion("nginx-1.0.0"); ok {
		t.Fatal("another chart is not Traefik")
	}
}

func TestTraefikAccessLogKeysFollowTheChartMajor(t *testing.T) {
	newer := traefikAccessLogSets(41, map[string]any{})
	want := []string{"accessLog.enabled=true", "accessLog.format=json", "accessLog.fields.headers.names.User-Agent=keep"}
	if !reflect.DeepEqual(newer, want) {
		t.Fatalf("chart 41 got %v", newer)
	}
	older := traefikAccessLogSets(34, map[string]any{})
	want = []string{"logs.access.enabled=true", "logs.access.format=json", "logs.access.fields.headers.names.User-Agent=keep"}
	if !reflect.DeepEqual(older, want) {
		t.Fatalf("chart 34 got %v", older)
	}
}

func TestTraefikAccessLogsAlreadyOnIsANoOp(t *testing.T) {
	current := map[string]any{
		"accessLog": map[string]any{
			"enabled": true,
			"format":  "json",
			"fields": map[string]any{
				"headers": map[string]any{"names": map[string]any{"User-Agent": "keep"}},
			},
		},
	}
	if sets := traefikAccessLogSets(41, current); len(sets) != 0 {
		t.Fatalf("expected nothing to set, got %v", sets)
	}
	current["accessLog"].(map[string]any)["format"] = "common"
	if sets := traefikAccessLogSets(41, current); !reflect.DeepEqual(sets, []string{"accessLog.format=json"}) {
		t.Fatalf("only the format should change, got %v", sets)
	}
}
