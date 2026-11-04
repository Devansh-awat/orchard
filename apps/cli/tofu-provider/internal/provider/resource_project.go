package provider

import (
	"context"
	"net/http"

	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/hackclub/orchard/cli/internal/api"
)

var (
	_ resource.Resource                = &projectResource{}
	_ resource.ResourceWithConfigure   = &projectResource{}
	_ resource.ResourceWithImportState = &projectResource{}
)

type projectResource struct {
	client *api.Client
}

type projectModel struct {
	ID             types.String `tfsdk:"id"`
	OrganizationID types.String `tfsdk:"organization_id"`
	Name           types.String `tfsdk:"name"`
	Slug           types.String `tfsdk:"slug"`
	Description    types.String `tfsdk:"description"`
}

func newProjectResource() resource.Resource { return &projectResource{} }

func (r *projectResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_project"
}

func (r *projectResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "A project: the unit apps, databases and jobs belong to.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:      true,
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"organization_id": schema.StringAttribute{
				Description:   "Organization the project belongs to. Changing it replaces the project.",
				Required:      true,
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"name": schema.StringAttribute{
				Required: true,
			},
			"slug": schema.StringAttribute{
				Description:   "URL slug. Derived from the name when omitted.",
				Optional:      true,
				Computed:      true,
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown(), stringplanmodifier.RequiresReplace()},
			},
			"description": schema.StringAttribute{
				Optional: true,
				Computed: true,
			},
		},
	}
}

func (r *projectResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = configureClient(req, resp)
}

func (r *projectResource) fill(m *projectModel, raw map[string]any) {
	m.ID = types.StringValue(str(raw, "id"))
	if v := str(raw, "organizationId"); v != "" {
		m.OrganizationID = types.StringValue(v)
	}
	m.Name = types.StringValue(str(raw, "name"))
	m.Slug = types.StringValue(str(raw, "slug"))
	m.Description = types.StringValue(str(raw, "description"))
}

func (r *projectResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan projectModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	body := map[string]any{
		"organizationId": plan.OrganizationID.ValueString(),
		"name":           plan.Name.ValueString(),
	}
	if !plan.Slug.IsNull() && !plan.Slug.IsUnknown() && plan.Slug.ValueString() != "" {
		body["slug"] = plan.Slug.ValueString()
	}
	if !plan.Description.IsNull() && !plan.Description.IsUnknown() {
		body["description"] = plan.Description.ValueString()
	}
	var raw map[string]any
	if err := send(ctx, r.client, http.MethodPost, "/projects", body, &raw); err != nil {
		resp.Diagnostics.AddError("Couldn't create project", err.Error())
		return
	}
	r.fill(&plan, raw)
	resp.Diagnostics.Append(resp.State.Set(ctx, plan)...)
}

func (r *projectResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state projectModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var raw map[string]any
	if err := getJSON(ctx, r.client, "/projects/"+esc(state.ID.ValueString()), &raw); err != nil {
		if isNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Couldn't read project", err.Error())
		return
	}
	r.fill(&state, raw)
	resp.Diagnostics.Append(resp.State.Set(ctx, state)...)
}

func (r *projectResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan, state projectModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	body := map[string]any{"name": plan.Name.ValueString()}
	if !plan.Description.IsNull() && !plan.Description.IsUnknown() {
		body["description"] = plan.Description.ValueString()
	}
	var raw map[string]any
	if err := send(ctx, r.client, http.MethodPatch, "/projects/"+esc(state.ID.ValueString()), body, &raw); err != nil {
		resp.Diagnostics.AddError("Couldn't update project", err.Error())
		return
	}
	plan.ID = state.ID
	r.fill(&plan, raw)
	resp.Diagnostics.Append(resp.State.Set(ctx, plan)...)
}

func (r *projectResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state projectModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := send(ctx, r.client, http.MethodDelete, "/projects/"+esc(state.ID.ValueString()), nil, nil); err != nil && !isNotFound(err) {
		resp.Diagnostics.AddError("Couldn't delete project", err.Error())
	}
}

func (r *projectResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}
