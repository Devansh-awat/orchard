package provider

import (
	"context"
	"os"

	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/provider"
	"github.com/hashicorp/terraform-plugin-framework/provider/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/hackclub/orchard/cli/internal/api"
	"github.com/hackclub/orchard/cli/internal/config"
)

// Ensure the provider satisfies the framework interfaces.
var _ provider.Provider = &orchardProvider{}

type orchardProvider struct {
	version string
}

type providerModel struct {
	APIURL types.String `tfsdk:"api_url"`
	Token  types.String `tfsdk:"token"`
}

// New returns the provider constructor the server and tests share.
func New(version string) func() provider.Provider {
	return func() provider.Provider {
		return &orchardProvider{version: version}
	}
}

func (p *orchardProvider) Metadata(_ context.Context, _ provider.MetadataRequest, resp *provider.MetadataResponse) {
	resp.TypeName = "orchard"
	resp.Version = p.version
}

func (p *orchardProvider) Schema(_ context.Context, _ provider.SchemaRequest, resp *provider.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "Manage Orchard projects, apps, databases, ingresses and jobs. Works with Terraform and OpenTofu.",
		Attributes: map[string]schema.Attribute{
			"api_url": schema.StringAttribute{
				Description: "Base URL of the Orchard instance. Falls back to ORCHARD_API_URL, then the CLI config, then the built-in default.",
				Optional:    true,
			},
			"token": schema.StringAttribute{
				Description: "API token. Falls back to ORCHARD_API_TOKEN, then the CLI's saved login.",
				Optional:    true,
				Sensitive:   true,
			},
		},
	}
}

func (p *orchardProvider) Configure(ctx context.Context, req provider.ConfigureRequest, resp *provider.ConfigureResponse) {
	var cfg providerModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &cfg)...)
	if resp.Diagnostics.HasError() {
		return
	}

	saved, _ := config.Load()
	apiURL := firstNonEmpty(cfg.APIURL.ValueString(), os.Getenv("ORCHARD_API_URL"))
	token := firstNonEmpty(cfg.Token.ValueString(), os.Getenv("ORCHARD_API_TOKEN"))
	if saved != nil {
		apiURL = firstNonEmpty(apiURL, saved.APIURL)
		token = firstNonEmpty(token, saved.Token)
	}
	if apiURL == "" {
		apiURL = config.DefaultAPIURL
	}
	if token == "" {
		resp.Diagnostics.AddError(
			"No Orchard token",
			"Set `token` on the provider, export ORCHARD_API_TOKEN, or run `orchard auth login` first.",
		)
		return
	}

	client := api.New(apiURL, token)
	resp.ResourceData = client
	resp.DataSourceData = client
}

func (p *orchardProvider) Resources(_ context.Context) []func() resource.Resource {
	return []func() resource.Resource{
		newProjectResource,
		newDeploymentResource,
		newDatabaseResource,
		newIngressResource,
		newEnvVarResource,
		newJobResource,
	}
}

func (p *orchardProvider) DataSources(_ context.Context) []func() datasource.DataSource {
	return nil
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}
