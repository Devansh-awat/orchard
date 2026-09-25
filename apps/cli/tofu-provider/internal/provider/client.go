package provider

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/resource"

	"github.com/hackclub/orchard/cli/internal/api"
)

// clientFrom pulls the configured API client out of a resource request, or
// explains why it is missing.
func clientFrom(data any, diags *diag.Diagnostics) *api.Client {
	if data == nil {
		return nil
	}
	client, ok := data.(*api.Client)
	if !ok {
		diags.AddError("Provider misconfigured", fmt.Sprintf("expected *api.Client, got %T", data))
		return nil
	}
	return client
}

func configureClient(req resource.ConfigureRequest, resp *resource.ConfigureResponse) *api.Client {
	return clientFrom(req.ProviderData, &resp.Diagnostics)
}

// isNotFound tells a vanished resource apart from every other failure, so
// Read can drop it from state instead of erroring forever.
func isNotFound(err error) bool {
	var apiErr *api.APIError
	if errors.As(err, &apiErr) {
		return apiErr.Status == http.StatusNotFound
	}
	return false
}

func esc(id string) string {
	return url.PathEscape(id)
}

func getJSON(ctx context.Context, client *api.Client, path string, out any) error {
	return client.GetJSON(ctx, path, out)
}

func send(ctx context.Context, client *api.Client, method, path string, in, out any) error {
	return client.Send(ctx, method, path, in, out)
}

// str reads a string field from a decoded JSON object, tolerating numbers.
func str(m map[string]any, keys ...string) string {
	for _, k := range keys {
		switch v := m[k].(type) {
		case string:
			return v
		case float64:
			return strings.TrimSuffix(strings.TrimSuffix(fmt.Sprintf("%f", v), "000000"), ".")
		case bool:
			if v {
				return "true"
			}
			return "false"
		}
	}
	return ""
}

func num(m map[string]any, key string) int64 {
	if v, ok := m[key].(float64); ok {
		return int64(v)
	}
	return 0
}

func boolean(m map[string]any, key string) bool {
	v, _ := m[key].(bool)
	return v
}

func list(v any) []map[string]any {
	items, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]map[string]any, 0, len(items))
	for _, it := range items {
		if m, ok := it.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}
