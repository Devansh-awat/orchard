package provider

import (
	"context"
	"net/http"

	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/int64planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/hackclub/orchard/cli/internal/api"
)

var (
	_ resource.Resource                = &databaseResource{}
	_ resource.ResourceWithConfigure   = &databaseResource{}
	_ resource.ResourceWithImportState = &databaseResource{}
)

type databaseResource struct {
	client *api.Client
}

type databaseModel struct {
	ID            types.String `tfsdk:"id"`
	ProjectID     types.String `tfsdk:"project_id"`
	EnvironmentID types.String `tfsdk:"environment_id"`
	Name          types.String `tfsdk:"name"`
	StorageSize   types.String `tfsdk:"storage_size"`
	PgMajor       types.Int64  `tfsdk:"pg_major"`
	Replicas      types.Int64  `tfsdk:"replicas"`
	Status        types.String `tfsdk:"status"`
	Host          types.String `tfsdk:"host"`
	Port          types.Int64  `tfsdk:"port"`
	DatabaseName  types.String `tfsdk:"database_name"`
}

func newDatabaseResource() resource.Resource { return &databaseResource{} }

func (r *databaseResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_database"
}

func (r *databaseResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "A managed Postgres database. Credentials never enter state: bind it to an app with orchard_env_var and a `${{resource.<name>.connection_string}}` reference.",
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
				Description:   "Environment the database lives in. The project default when omitted.",
				Optional:      true,
				Computed:      true,
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown(), stringplanmodifier.RequiresReplace()},
			},
			"name": schema.StringAttribute{
				Required:      true,
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"storage_size": schema.StringAttribute{
				Description:   "Volume size, for example 5Gi. Only grows in Orchard, so a change here replaces the database.",
				Optional:      true,
				Computed:      true,
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown(), stringplanmodifier.RequiresReplace()},
			},
			"pg_major": schema.Int64Attribute{
				Optional:      true,
				Computed:      true,
				PlanModifiers: []planmodifier.Int64{int64planmodifier.UseStateForUnknown(), int64planmodifier.RequiresReplace()},
			},
			"replicas": schema.Int64Attribute{
				Description:   "Total Postgres instances, one primary plus standbys.",
				Optional:      true,
				Computed:      true,
				PlanModifiers: []planmodifier.Int64{int64planmodifier.UseStateForUnknown(), int64planmodifier.RequiresReplace()},
			},
			"status":        schema.StringAttribute{Computed: true},
			"host":          schema.StringAttribute{Computed: true},
			"port":          schema.Int64Attribute{Computed: true},
			"database_name": schema.StringAttribute{Computed: true},
		},
	}
}

func (r *databaseResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = configureClient(req, resp)
}

func (r *databaseResource) fill(m *databaseModel, raw map[string]any) {
	m.ID = types.StringValue(str(raw, "id"))
	if v := str(raw, "projectId"); v != "" {
		m.ProjectID = types.StringValue(v)
	}
	m.EnvironmentID = types.StringValue(str(raw, "environmentId"))
	m.Name = types.StringValue(str(raw, "name"))
	m.StorageSize = types.StringValue(str(raw, "storageSize"))
	m.PgMajor = types.Int64Value(num(raw, "pgMajor"))
	m.Replicas = types.Int64Value(num(raw, "replicas"))
	m.Status = types.StringValue(str(raw, "status"))
	m.Host = types.StringValue(str(raw, "host"))
	m.Port = types.Int64Value(num(raw, "port"))
	m.DatabaseName = types.StringValue(str(raw, "dbName"))
}

func (r *databaseResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan databaseModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	body := map[string]any{"name": plan.Name.ValueString()}
	if s := plan.StorageSize; !s.IsNull() && !s.IsUnknown() && s.ValueString() != "" {
		body["storageSize"] = s.ValueString()
	}
	if v := plan.PgMajor; !v.IsNull() && !v.IsUnknown() && v.ValueInt64() > 0 {
		body["pgMajor"] = v.ValueInt64()
	}
	if v := plan.Replicas; !v.IsNull() && !v.IsUnknown() && v.ValueInt64() > 0 {
		body["replicas"] = v.ValueInt64()
	}
	if v := plan.EnvironmentID; !v.IsNull() && !v.IsUnknown() && v.ValueString() != "" {
		body["environmentId"] = v.ValueString()
	}
	var raw map[string]any
	if err := send(ctx, r.client, http.MethodPost, "/projects/"+esc(plan.ProjectID.ValueString())+"/databases", body, &raw); err != nil {
		resp.Diagnostics.AddError("Couldn't create database", err.Error())
		return
	}
	r.fill(&plan, raw)
	resp.Diagnostics.Append(resp.State.Set(ctx, plan)...)
}

func (r *databaseResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state databaseModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var raw map[string]any
	if err := getJSON(ctx, r.client, "/databases/"+esc(state.ID.ValueString()), &raw); err != nil {
		if isNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Couldn't read database", err.Error())
		return
	}
	r.fill(&state, raw)
	resp.Diagnostics.Append(resp.State.Set(ctx, state)...)
}

func (r *databaseResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan, state databaseModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if plan.Name.ValueString() != state.Name.ValueString() {
		if err := send(ctx, r.client, http.MethodPatch, "/databases/"+esc(state.ID.ValueString())+"/name", map[string]any{"name": plan.Name.ValueString()}, nil); err != nil {
			resp.Diagnostics.AddError("Couldn't rename database", err.Error())
			return
		}
	}
	plan.ID = state.ID
	var raw map[string]any
	if err := getJSON(ctx, r.client, "/databases/"+esc(state.ID.ValueString()), &raw); err == nil {
		r.fill(&plan, raw)
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, plan)...)
}

func (r *databaseResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state databaseModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := send(ctx, r.client, http.MethodDelete, "/databases/"+esc(state.ID.ValueString()), nil, nil); err != nil && !isNotFound(err) {
		resp.Diagnostics.AddError("Couldn't delete database", err.Error())
	}
}

func (r *databaseResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}
