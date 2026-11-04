package provider

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/hackclub/orchard/cli/internal/api"
)

var (
	_ resource.Resource                = &ingressResource{}
	_ resource.ResourceWithConfigure   = &ingressResource{}
	_ resource.ResourceWithImportState = &ingressResource{}
)

type ingressResource struct {
	client *api.Client
}

type ingressModel struct {
	ID           types.String `tfsdk:"id"`
	ProjectID    types.String `tfsdk:"project_id"`
	DeploymentID types.String `tfsdk:"deployment_id"`
	Host         types.String `tfsdk:"host"`
	TLS          types.Bool   `tfsdk:"tls"`
	Status       types.String `tfsdk:"status"`
}

func newIngressResource() resource.Resource { return &ingressResource{} }

func (r *ingressResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_ingress"
}

func (r *ingressResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "A custom domain routed to an app. Point the domain at the instance with a CNAME first.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:      true,
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"project_id": schema.StringAttribute{
				Required:      true,
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"deployment_id": schema.StringAttribute{
				Description:   "The app the host routes to.",
				Required:      true,
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"host": schema.StringAttribute{
				Required: true,
			},
			"tls": schema.BoolAttribute{
				Optional: true,
				Computed: true,
				Default:  booldefault.StaticBool(true),
			},
			"status": schema.StringAttribute{Computed: true},
		},
	}
}

func (r *ingressResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = configureClient(req, resp)
}

func (r *ingressResource) fill(m *ingressModel, raw map[string]any) {
	m.ID = types.StringValue(str(raw, "id"))
	m.Host = types.StringValue(str(raw, "host"))
	m.TLS = types.BoolValue(boolean(raw, "tlsEnabled"))
	m.Status = types.StringValue(str(raw, "status"))
	if v := str(raw, "deploymentId"); v != "" {
		m.DeploymentID = types.StringValue(v)
	}
}

func (r *ingressResource) ingressPath(m ingressModel) string {
	return "/projects/" + esc(m.ProjectID.ValueString()) + "/ingresses/" + esc(m.ID.ValueString())
}

func (r *ingressResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan ingressModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	body := map[string]any{
		"host":         strings.ToLower(strings.TrimSpace(plan.Host.ValueString())),
		"deploymentId": plan.DeploymentID.ValueString(),
		"tlsEnabled":   plan.TLS.ValueBool(),
	}
	var raw map[string]any
	if err := send(ctx, r.client, http.MethodPost, "/projects/"+esc(plan.ProjectID.ValueString())+"/ingresses", body, &raw); err != nil {
		resp.Diagnostics.AddError("Couldn't create domain", err.Error())
		return
	}
	r.fill(&plan, raw)
	resp.Diagnostics.Append(resp.State.Set(ctx, plan)...)
}

func (r *ingressResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state ingressModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var raw map[string]any
	if err := getJSON(ctx, r.client, r.ingressPath(state), &raw); err != nil {
		if isNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Couldn't read domain", err.Error())
		return
	}
	r.fill(&state, raw)
	resp.Diagnostics.Append(resp.State.Set(ctx, state)...)
}

func (r *ingressResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan, state ingressModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	plan.ID = state.ID
	var current map[string]any
	if err := getJSON(ctx, r.client, r.ingressPath(state), &current); err != nil {
		resp.Diagnostics.AddError("Couldn't read domain before updating it", err.Error())
		return
	}
	routes := []map[string]any{}
	for _, rt := range list(current["routes"]) {
		routes = append(routes, map[string]any{
			"path":        firstNonEmpty(str(rt, "path"), "/"),
			"serviceName": str(rt, "serviceName"),
			"servicePort": num(rt, "servicePort"),
		})
	}
	body := map[string]any{
		"host":       strings.ToLower(strings.TrimSpace(plan.Host.ValueString())),
		"tlsEnabled": plan.TLS.ValueBool(),
		"routes":     routes,
	}
	var raw map[string]any
	if err := send(ctx, r.client, http.MethodPut, r.ingressPath(state), body, &raw); err != nil {
		resp.Diagnostics.AddError("Couldn't update domain", err.Error())
		return
	}
	r.fill(&plan, raw)
	resp.Diagnostics.Append(resp.State.Set(ctx, plan)...)
}

func (r *ingressResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state ingressModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := send(ctx, r.client, http.MethodDelete, r.ingressPath(state), nil, nil); err != nil && !isNotFound(err) {
		resp.Diagnostics.AddError("Couldn't delete domain", err.Error())
	}
}

func (r *ingressResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	parts := strings.SplitN(req.ID, ":", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		resp.Diagnostics.AddError("Bad import id", fmt.Sprintf("expected <project id>:<ingress id>, got %q", req.ID))
		return
	}
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("project_id"), parts[0])...)
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("id"), parts[1])...)
}
