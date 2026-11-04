package provider

import (
	"context"
	"net/http"

	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/int64default"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/int64planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/hackclub/orchard/cli/internal/api"
)

var (
	_ resource.Resource                = &deploymentResource{}
	_ resource.ResourceWithConfigure   = &deploymentResource{}
	_ resource.ResourceWithImportState = &deploymentResource{}
)

type deploymentResource struct {
	client *api.Client
}

type deploymentModel struct {
	ID            types.String `tfsdk:"id"`
	ProjectID     types.String `tfsdk:"project_id"`
	EnvironmentID types.String `tfsdk:"environment_id"`
	Name          types.String `tfsdk:"name"`
	Image         types.String `tfsdk:"image"`
	Port          types.Int64  `tfsdk:"port"`
	Replicas      types.Int64  `tfsdk:"replicas"`
	ExposePublic  types.Bool   `tfsdk:"expose_public"`
	AutoURL       types.Bool   `tfsdk:"auto_url"`
	StartCommand  types.String `tfsdk:"start_command"`
	Status        types.String `tfsdk:"status"`
	Namespace     types.String `tfsdk:"namespace"`
	InternalURL   types.String `tfsdk:"internal_url"`
}

func newDeploymentResource() resource.Resource { return &deploymentResource{} }

func (r *deploymentResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_deployment"
}

func (r *deploymentResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "An app running a container image. Repository-built apps are created from the dashboard or `orchard deploy create --github`; this resource manages image-based ones, and can read either.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:      true,
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"project_id": schema.StringAttribute{
				Required:      true,
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"environment_id": schema.StringAttribute{
				Optional:      true,
				Computed:      true,
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown(), stringplanmodifier.RequiresReplace()},
			},
			"name": schema.StringAttribute{
				Required:      true,
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"image": schema.StringAttribute{
				Description: "Container image with tag. Changing it rolls the app.",
				Required:    true,
			},
			"port": schema.Int64Attribute{
				Description:   "The port the container listens on.",
				Optional:      true,
				Computed:      true,
				Default:       int64default.StaticInt64(80),
				PlanModifiers: []planmodifier.Int64{int64planmodifier.RequiresReplace()},
			},
			"replicas": schema.Int64Attribute{
				Optional: true,
				Computed: true,
				Default:  int64default.StaticInt64(1),
			},
			"expose_public": schema.BoolAttribute{
				Optional:      true,
				Computed:      true,
				Default:       booldefault.StaticBool(false),
				PlanModifiers: []planmodifier.Bool{},
			},
			"auto_url": schema.BoolAttribute{
				Description: "Generate an https address under the apps domain.",
				Optional:    true,
				Computed:    true,
				Default:     booldefault.StaticBool(true),
			},
			"start_command": schema.StringAttribute{
				Description:   "Overrides the image's CMD.",
				Optional:      true,
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"status":       schema.StringAttribute{Computed: true},
			"namespace":    schema.StringAttribute{Computed: true},
			"internal_url": schema.StringAttribute{Computed: true, Description: "Private address other apps on the project can use."},
		},
	}
}

func (r *deploymentResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = configureClient(req, resp)
}

func (r *deploymentResource) fill(m *deploymentModel, raw map[string]any) {
	m.ID = types.StringValue(str(raw, "id"))
	if v := str(raw, "projectId"); v != "" {
		m.ProjectID = types.StringValue(v)
	}
	m.EnvironmentID = types.StringValue(str(raw, "environmentId"))
	m.Name = types.StringValue(str(raw, "name"))
	m.Image = types.StringValue(str(raw, "image"))
	m.Replicas = types.Int64Value(num(raw, "replicas"))
	m.Status = types.StringValue(str(raw, "status"))
	m.Namespace = types.StringValue(str(raw, "namespace"))
	internal := ""
	for _, svc := range list(raw["services"]) {
		if svc["type"] == "external" {
			m.ExposePublic = types.BoolValue(true)
		}
		if internal == "" {
			internal = str(svc, "internalUrl")
		}
		for _, p := range list(svc["ports"]) {
			if internal == "" {
				internal = str(p, "internalUrl")
			}
			if m.Port.IsNull() || m.Port.IsUnknown() || m.Port.ValueInt64() == 0 {
				m.Port = types.Int64Value(num(p, "targetPort"))
			}
		}
	}
	if m.ExposePublic.IsNull() || m.ExposePublic.IsUnknown() {
		m.ExposePublic = types.BoolValue(false)
	}
	if m.AutoURL.IsNull() || m.AutoURL.IsUnknown() {
		m.AutoURL = types.BoolValue(true)
	}
	m.InternalURL = types.StringValue(internal)
}

func (r *deploymentResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan deploymentModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	body := map[string]any{
		"name":         plan.Name.ValueString(),
		"image":        plan.Image.ValueString(),
		"port":         plan.Port.ValueInt64(),
		"replicas":     plan.Replicas.ValueInt64(),
		"exposePublic": plan.ExposePublic.ValueBool(),
		"autoUrl":      plan.AutoURL.ValueBool(),
	}
	if v := plan.EnvironmentID; !v.IsNull() && !v.IsUnknown() && v.ValueString() != "" {
		body["environmentId"] = v.ValueString()
	}
	if v := plan.StartCommand; !v.IsNull() && !v.IsUnknown() && v.ValueString() != "" {
		body["startCommand"] = v.ValueString()
	}
	var raw map[string]any
	if err := send(ctx, r.client, http.MethodPost, "/projects/"+esc(plan.ProjectID.ValueString())+"/deployments", body, &raw); err != nil {
		resp.Diagnostics.AddError("Couldn't create app", err.Error())
		return
	}
	r.fill(&plan, raw)
	resp.Diagnostics.Append(resp.State.Set(ctx, plan)...)
}

func (r *deploymentResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state deploymentModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var raw map[string]any
	if err := getJSON(ctx, r.client, "/deployments/"+esc(state.ID.ValueString()), &raw); err != nil {
		if isNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Couldn't read app", err.Error())
		return
	}
	r.fill(&state, raw)
	resp.Diagnostics.Append(resp.State.Set(ctx, state)...)
}

func (r *deploymentResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan, state deploymentModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	id := state.ID.ValueString()
	if plan.Image.ValueString() != state.Image.ValueString() {
		if err := send(ctx, r.client, http.MethodPatch, "/deployments/"+esc(id)+"/image", map[string]any{"image": plan.Image.ValueString()}, nil); err != nil {
			resp.Diagnostics.AddError("Couldn't change image", err.Error())
			return
		}
	}
	if plan.Replicas.ValueInt64() != state.Replicas.ValueInt64() {
		if err := send(ctx, r.client, http.MethodPost, "/deployments/"+esc(id)+"/scale", map[string]any{"replicas": plan.Replicas.ValueInt64()}, nil); err != nil {
			resp.Diagnostics.AddError("Couldn't scale app", err.Error())
			return
		}
	}
	plan.ID = state.ID
	var raw map[string]any
	if err := getJSON(ctx, r.client, "/deployments/"+esc(id), &raw); err == nil {
		r.fill(&plan, raw)
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, plan)...)
}

func (r *deploymentResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state deploymentModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := send(ctx, r.client, http.MethodDelete, "/deployments/"+esc(state.ID.ValueString()), nil, nil); err != nil && !isNotFound(err) {
		resp.Diagnostics.AddError("Couldn't delete app", err.Error())
	}
}

func (r *deploymentResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}
