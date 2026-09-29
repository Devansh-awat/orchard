package provider

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/hackclub/orchard/cli/internal/api"
)

var (
	_ resource.Resource                = &envVarResource{}
	_ resource.ResourceWithConfigure   = &envVarResource{}
	_ resource.ResourceWithImportState = &envVarResource{}
)

type envVarResource struct {
	client *api.Client
}

type envVarModel struct {
	ID           types.String `tfsdk:"id"`
	DeploymentID types.String `tfsdk:"deployment_id"`
	Key          types.String `tfsdk:"key"`
	Value        types.String `tfsdk:"value"`
	Secret       types.Bool   `tfsdk:"secret"`
}

func newEnvVarResource() resource.Resource { return &envVarResource{} }

func (r *envVarResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_env_var"
}

func (r *envVarResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "One environment variable on an app. Other variables on the app are left alone. A value like `${{resource.db.connection_string}}` reads a connected database live; a secret is marked sensitive, so it is redacted from plan output, but like every provider attribute it is stored in the state file: keep state encrypted.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:      true,
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"deployment_id": schema.StringAttribute{
				Required:      true,
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"key": schema.StringAttribute{
				Required:      true,
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"value": schema.StringAttribute{
				Required:  true,
				Sensitive: true,
			},
			"secret": schema.BoolAttribute{
				Description: "Store it in a Kubernetes Secret and never return it from the API.",
				Optional:    true,
				Computed:    true,
			},
		},
	}
}

func (r *envVarResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = configureClient(req, resp)
}

// current lists the app's variables with `value: null` so a PUT keeps every
// one of them untouched, which is how the API says "leave this alone".
func (r *envVarResource) current(ctx context.Context, deploymentID string) ([]map[string]any, error) {
	var dep map[string]any
	if err := getJSON(ctx, r.client, "/deployments/"+esc(deploymentID), &dep); err != nil {
		return nil, err
	}
	out := []map[string]any{}
	for _, v := range list(dep["envVars"]) {
		out = append(out, map[string]any{"key": str(v, "key"), "value": nil, "secret": boolean(v, "secret")})
	}
	return out, nil
}

func (r *envVarResource) put(ctx context.Context, m envVarModel, remove bool) error {
	vars, err := r.current(ctx, m.DeploymentID.ValueString())
	if err != nil {
		return err
	}
	kept := vars[:0]
	for _, v := range vars {
		if v["key"] != m.Key.ValueString() {
			kept = append(kept, v)
		}
	}
	if !remove {
		kept = append(kept, map[string]any{
			"key":    m.Key.ValueString(),
			"value":  m.Value.ValueString(),
			"secret": m.Secret.ValueBool(),
		})
	}
	return send(ctx, r.client, http.MethodPut, "/deployments/"+esc(m.DeploymentID.ValueString())+"/env", map[string]any{"env": kept}, nil)
}

func (r *envVarResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan envVarModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if plan.Secret.IsUnknown() || plan.Secret.IsNull() {
		plan.Secret = types.BoolValue(false)
	}
	if err := r.put(ctx, plan, false); err != nil {
		resp.Diagnostics.AddError("Could not set variable", err.Error())
		return
	}
	plan.ID = types.StringValue(plan.DeploymentID.ValueString() + ":" + plan.Key.ValueString())
	resp.Diagnostics.Append(resp.State.Set(ctx, plan)...)
}

func (r *envVarResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state envVarModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var dep map[string]any
	if err := getJSON(ctx, r.client, "/deployments/"+esc(state.DeploymentID.ValueString()), &dep); err != nil {
		if isNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Could not read app", err.Error())
		return
	}
	found := false
	for _, v := range list(dep["envVars"]) {
		if str(v, "key") != state.Key.ValueString() {
			continue
		}
		found = true
		state.Secret = types.BoolValue(boolean(v, "secret"))
		if !state.Secret.ValueBool() {
			if val, ok := v["value"].(string); ok {
				state.Value = types.StringValue(val)
			}
		}
	}
	if !found {
		resp.State.RemoveResource(ctx)
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, state)...)
}

func (r *envVarResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan, state envVarModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if plan.Secret.IsUnknown() || plan.Secret.IsNull() {
		plan.Secret = state.Secret
	}
	if err := r.put(ctx, plan, false); err != nil {
		resp.Diagnostics.AddError("Could not update variable", err.Error())
		return
	}
	plan.ID = state.ID
	resp.Diagnostics.Append(resp.State.Set(ctx, plan)...)
}

func (r *envVarResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state envVarModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.put(ctx, state, true); err != nil && !isNotFound(err) {
		resp.Diagnostics.AddError("Could not remove variable", err.Error())
	}
}

func (r *envVarResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	parts := strings.SplitN(req.ID, ":", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		resp.Diagnostics.AddError("Bad import id", fmt.Sprintf("expected <deployment id>:<KEY>, got %q", req.ID))
		return
	}
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("id"), req.ID)...)
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("deployment_id"), parts[0])...)
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("key"), parts[1])...)
}
