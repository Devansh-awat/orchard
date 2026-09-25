package provider

import (
	"context"
	"testing"

	fwprovider "github.com/hashicorp/terraform-plugin-framework/provider"
	"github.com/hashicorp/terraform-plugin-framework/resource"
)

// Every resource must answer Metadata and Schema without touching the API,
// and the framework's own validation must accept each schema. This is what
// `terraform init` exercises before any plan.
func TestProviderSchemasAreValid(t *testing.T) {
	ctx := context.Background()
	p := New("test")()

	var meta fwprovider.MetadataResponse
	p.Metadata(ctx, fwprovider.MetadataRequest{}, &meta)
	if meta.TypeName != "orchard" {
		t.Fatalf("type name = %q, want orchard", meta.TypeName)
	}

	var ps fwprovider.SchemaResponse
	p.Schema(ctx, fwprovider.SchemaRequest{}, &ps)
	if ps.Diagnostics.HasError() {
		t.Fatalf("provider schema: %v", ps.Diagnostics)
	}
	if diags := ps.Schema.ValidateImplementation(ctx); diags.HasError() {
		t.Fatalf("provider schema invalid: %v", diags)
	}

	want := map[string]bool{
		"orchard_project":    true,
		"orchard_deployment": true,
		"orchard_database":   true,
		"orchard_ingress":    true,
		"orchard_env_var":    true,
		"orchard_job":        true,
	}
	for _, ctor := range p.Resources(ctx) {
		r := ctor()
		var m resource.MetadataResponse
		r.Metadata(ctx, resource.MetadataRequest{ProviderTypeName: "orchard"}, &m)
		if !want[m.TypeName] {
			t.Errorf("unexpected resource %q", m.TypeName)
		}
		delete(want, m.TypeName)
		var s resource.SchemaResponse
		r.Schema(ctx, resource.SchemaRequest{}, &s)
		if s.Diagnostics.HasError() {
			t.Errorf("%s schema: %v", m.TypeName, s.Diagnostics)
		}
		if diags := s.Schema.ValidateImplementation(ctx); diags.HasError() {
			t.Errorf("%s schema invalid: %v", m.TypeName, diags)
		}
		if _, ok := s.Schema.Attributes["id"]; !ok {
			t.Errorf("%s has no id attribute", m.TypeName)
		}
	}
	for name := range want {
		t.Errorf("resource %q not registered", name)
	}
}

func TestJSONHelpersTolerateShapes(t *testing.T) {
	m := map[string]any{"id": "abc", "replicas": float64(3), "on": true, "port": float64(8080)}
	if got := str(m, "id"); got != "abc" {
		t.Errorf("str id = %q", got)
	}
	if got := str(m, "replicas"); got != "3" {
		t.Errorf("str number = %q, want 3", got)
	}
	if got := str(m, "missing", "id"); got != "abc" {
		t.Errorf("str fallback = %q", got)
	}
	if got := num(m, "port"); got != 8080 {
		t.Errorf("num = %d", got)
	}
	if !boolean(m, "on") || boolean(m, "off") {
		t.Errorf("boolean wrong")
	}
	items := list([]any{map[string]any{"a": 1}, "junk", map[string]any{"b": 2}})
	if len(items) != 2 {
		t.Errorf("list kept %d items, want 2", len(items))
	}
	if list("nope") != nil {
		t.Errorf("list of a non-list should be nil")
	}
}
