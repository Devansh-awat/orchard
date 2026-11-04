package provider

import (
	"context"
	"net/http"

	"github.com/hashicorp/terraform-plugin-framework/attr"
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
	_ resource.Resource                = &jobResource{}
	_ resource.ResourceWithConfigure   = &jobResource{}
	_ resource.ResourceWithImportState = &jobResource{}
)

type jobResource struct {
	client *api.Client
}

type jobStepModel struct {
	Name    types.String `tfsdk:"name"`
	Image   types.String `tfsdk:"image"`
	Command types.String `tfsdk:"command"`
}

type jobModel struct {
	ID        types.String   `tfsdk:"id"`
	ProjectID types.String   `tfsdk:"project_id"`
	Name      types.String   `tfsdk:"name"`
	Schedule  types.String   `tfsdk:"schedule"`
	TimeZone  types.String   `tfsdk:"time_zone"`
	Enabled   types.Bool     `tfsdk:"enabled"`
	Steps     []jobStepModel `tfsdk:"steps"`
}

func newJobResource() resource.Resource { return &jobResource{} }

func (r *jobResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_job"
}

func (r *jobResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "A scheduled or on-demand job made of image steps run in order.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:      true,
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"project_id": schema.StringAttribute{
				Required:      true,
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"name": schema.StringAttribute{Required: true},
			"schedule": schema.StringAttribute{
				Description: "Five-field cron expression. Omit for a job that only runs on demand.",
				Optional:    true,
			},
			"time_zone": schema.StringAttribute{Optional: true},
			"enabled": schema.BoolAttribute{
				Optional: true,
				Computed: true,
				Default:  booldefault.StaticBool(true),
			},
		},
		Blocks: map[string]schema.Block{
			"steps": schema.ListNestedBlock{
				Description: "Steps run in order; each is an image with an optional command.",
				NestedObject: schema.NestedBlockObject{
					Attributes: map[string]schema.Attribute{
						"name":    schema.StringAttribute{Required: true},
						"image":   schema.StringAttribute{Required: true},
						"command": schema.StringAttribute{Optional: true},
					},
				},
			},
		},
	}
}

func (r *jobResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = configureClient(req, resp)
}

func (r *jobResource) stepsBody(m jobModel) []map[string]any {
	out := []map[string]any{}
	for _, s := range m.Steps {
		step := map[string]any{"name": s.Name.ValueString(), "type": "image", "image": s.Image.ValueString()}
		if !s.Command.IsNull() && !s.Command.IsUnknown() && s.Command.ValueString() != "" {
			step["command"] = s.Command.ValueString()
		}
		out = append(out, step)
	}
	return out
}

func (r *jobResource) fill(m *jobModel, raw map[string]any) {
	m.ID = types.StringValue(str(raw, "id"))
	if v := str(raw, "projectId"); v != "" {
		m.ProjectID = types.StringValue(v)
	}
	m.Name = types.StringValue(str(raw, "name"))
	if v := str(raw, "scheduleCron"); v != "" {
		m.Schedule = types.StringValue(v)
	} else {
		m.Schedule = types.StringNull()
	}
	if v := str(raw, "timeZone"); v != "" {
		m.TimeZone = types.StringValue(v)
	} else {
		m.TimeZone = types.StringNull()
	}
	m.Enabled = types.BoolValue(boolean(raw, "enabled"))
	steps := list(raw["steps"])
	if len(steps) > 0 {
		m.Steps = nil
		for _, s := range steps {
			step := jobStepModel{Name: types.StringValue(str(s, "name")), Image: types.StringValue(str(s, "image"))}
			if v := str(s, "command"); v != "" {
				step.Command = types.StringValue(v)
			} else {
				step.Command = types.StringNull()
			}
			m.Steps = append(m.Steps, step)
		}
	}
}

func (r *jobResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan jobModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	body := map[string]any{
		"name":    plan.Name.ValueString(),
		"enabled": plan.Enabled.ValueBool(),
		"steps":   r.stepsBody(plan),
	}
	if v := plan.Schedule; !v.IsNull() && !v.IsUnknown() && v.ValueString() != "" {
		body["scheduleCron"] = v.ValueString()
	}
	if v := plan.TimeZone; !v.IsNull() && !v.IsUnknown() && v.ValueString() != "" {
		body["timeZone"] = v.ValueString()
	}
	var raw map[string]any
	if err := send(ctx, r.client, http.MethodPost, "/projects/"+esc(plan.ProjectID.ValueString())+"/jobs", body, &raw); err != nil {
		resp.Diagnostics.AddError("Couldn't create job", err.Error())
		return
	}
	r.fill(&plan, raw)
	resp.Diagnostics.Append(resp.State.Set(ctx, plan)...)
}

func (r *jobResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state jobModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var raw map[string]any
	if err := getJSON(ctx, r.client, "/jobs/"+esc(state.ID.ValueString()), &raw); err != nil {
		if isNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Couldn't read job", err.Error())
		return
	}
	r.fill(&state, raw)
	resp.Diagnostics.Append(resp.State.Set(ctx, state)...)
}

func (r *jobResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan, state jobModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	id := state.ID.ValueString()
	patch := map[string]any{
		"name":         plan.Name.ValueString(),
		"enabled":      plan.Enabled.ValueBool(),
		"scheduleCron": nil,
		"timeZone":     nil,
	}
	if v := plan.Schedule; !v.IsNull() && !v.IsUnknown() && v.ValueString() != "" {
		patch["scheduleCron"] = v.ValueString()
	}
	if v := plan.TimeZone; !v.IsNull() && !v.IsUnknown() && v.ValueString() != "" {
		patch["timeZone"] = v.ValueString()
	}
	if err := send(ctx, r.client, http.MethodPatch, "/jobs/"+esc(id), patch, nil); err != nil {
		resp.Diagnostics.AddError("Couldn't update job", err.Error())
		return
	}
	if err := send(ctx, r.client, http.MethodPut, "/jobs/"+esc(id)+"/steps", map[string]any{"steps": r.stepsBody(plan)}, nil); err != nil {
		resp.Diagnostics.AddError("Couldn't update job steps", err.Error())
		return
	}
	plan.ID = state.ID
	var raw map[string]any
	if err := getJSON(ctx, r.client, "/jobs/"+esc(id), &raw); err == nil {
		r.fill(&plan, raw)
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, plan)...)
}

func (r *jobResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state jobModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := send(ctx, r.client, http.MethodDelete, "/jobs/"+esc(state.ID.ValueString()), nil, nil); err != nil && !isNotFound(err) {
		resp.Diagnostics.AddError("Couldn't delete job", err.Error())
	}
}

func (r *jobResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}

var _ attr.Value = types.StringNull()
