package tui

import (
	"context"
	"fmt"
	"net/url"
	"strconv"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/hackclub/orchard/cli/internal/api"
)

// dbDetail mirrors GET /databases/:id — the same fields cmd/db.go reads.
type dbDetail struct {
	ID               string  `json:"id"`
	Name             string  `json:"name"`
	Status           string  `json:"status"`
	Mode             string  `json:"mode"`
	Namespace        string  `json:"namespace"`
	StorageSize      string  `json:"storageSize"`
	Host             string  `json:"host"`
	Port             flexNum `json:"port"`
	DBName           string  `json:"dbName"`
	DBUser           string  `json:"dbUser"`
	ConnectionString string  `json:"connectionString"`
	PublicEnabled    bool    `json:"publicEnabled"`
	PublicIP         string  `json:"publicIp"`
	PublicHostname   string  `json:"publicHostname"`
	PublicPort       flexNum `json:"publicPort"`
	PublicConnStr    string  `json:"publicConnectionString"`
	CPURequestMilli  flexNum `json:"cpuRequestMilli"`
	MemoryRequestB   flexNum `json:"memoryRequestBytes"`
	BackupsEnabled   bool    `json:"backupsEnabled"`
	Pods             []Pod   `json:"pods"`
	LiveStatus       *struct {
		Ready       bool    `json:"ready"`
		Connections flexNum `json:"connections"`
		Size        string  `json:"size"`
		Message     string  `json:"message"`
	} `json:"liveStatus"`
}

type dbBackup struct {
	ID         string  `json:"id"`
	Label      string  `json:"label"`
	BackupName string  `json:"backupName"`
	Type       string  `json:"type"`
	Status     string  `json:"status"`
	SizeBytes  flexNum `json:"sizeBytes"`
	CreatedAt  string  `json:"createdAt"`
}

type dbExtension struct {
	Name           string `json:"name"`
	Installed      bool   `json:"installed"`
	Version        string `json:"version"`
	DefaultVersion string `json:"defaultVersion"`
	Comment        string `json:"comment"`
}

// dbXY is one sample of the database metrics series. Unlike deployment metrics
// (timestamp/value), the db endpoint returns {x, y} points under raw["data"]
// with keys cpu/mem/rx/tx (see cmd/db.go metrics).
type dbXY struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

type dbMetricsResp struct {
	Data struct {
		CPU []dbXY `json:"cpu"`
		Mem []dbXY `json:"mem"`
		RX  []dbXY `json:"rx"`
		TX  []dbXY `json:"tx"`
	} `json:"data"`
}

type dbProvStep struct {
	ID     string `json:"id"`
	Label  string `json:"label"`
	Status string `json:"status"`
}

type dbProvisioning struct {
	Status string       `json:"status"`
	Phase  string       `json:"phase"`
	Done   bool         `json:"done"`
	Failed bool         `json:"failed"`
	Steps  []dbProvStep `json:"steps"`
}

type (
	dbDetailMsg struct {
		d   *dbDetail
		err error
	}
	dbBackupsMsg struct {
		items []dbBackup
		err   error
	}
	dbExtensionsMsg struct {
		exts    []dbExtension
		preload []string
		err     error
	}
	dbSettingsMsg struct {
		params map[string]string
		err    error
	}
	dbScheduleMsg struct {
		cron string
		err  error
	}
	dbMetricsMsg struct {
		m   dbMetricsResp
		err error
	}
	dbProvisioningMsg struct {
		p   *dbProvisioning
		err error
	}
	dbShellDoneMsg  struct{ err error }
	dbConnectionMsg struct {
		c   *dbConnection
		err error
	}
	// dbChangedMsg is delivered to the database screen when a pushed form
	// (schedule, extension install, resources, storage, settings) succeeds.
	dbChangedMsg struct{ text string }
)

func dbPath(id string) string { return "/databases/" + url.PathEscape(id) }

func fetchDBDetail(cl *api.Client, id string) tea.Cmd {
	return func() tea.Msg {
		var d dbDetail
		err := cl.GetJSON(context.Background(), dbPath(id), &d)
		if err != nil {
			return dbDetailMsg{nil, err}
		}
		return dbDetailMsg{&d, nil}
	}
}

type dbConnection struct {
	Password               string `json:"password"`
	ConnectionString       string `json:"connectionString"`
	PublicConnectionString string `json:"publicConnectionString"`
}

func getDBConnection(ctx context.Context, cl *api.Client, id string) (*dbConnection, error) {
	var c dbConnection
	if err := cl.GetJSON(ctx, dbPath(id)+"/connection", &c); err != nil {
		return nil, err
	}
	return &c, nil
}

func fetchDBConnection(cl *api.Client, id string) tea.Cmd {
	return func() tea.Msg {
		c, err := getDBConnection(context.Background(), cl, id)
		return dbConnectionMsg{c, err}
	}
}

func fetchDBBackups(cl *api.Client, id string) tea.Cmd {
	return func() tea.Msg {
		items, err := getList[dbBackup](cl, dbPath(id)+"/backups")
		return dbBackupsMsg{items, err}
	}
}

func fetchDBExtensions(cl *api.Client, id string) tea.Cmd {
	return func() tea.Msg {
		var raw struct {
			Extensions             []dbExtension `json:"extensions"`
			SharedPreloadLibraries []string      `json:"sharedPreloadLibraries"`
		}
		err := cl.GetJSON(context.Background(), dbPath(id)+"/extensions", &raw)
		return dbExtensionsMsg{raw.Extensions, raw.SharedPreloadLibraries, err}
	}
}

func fetchDBSettings(cl *api.Client, id string) tea.Cmd {
	return func() tea.Msg {
		var raw struct {
			Parameters map[string]any `json:"parameters"`
		}
		err := cl.GetJSON(context.Background(), dbPath(id)+"/settings", &raw)
		params := make(map[string]string, len(raw.Parameters))
		for k, v := range raw.Parameters {
			params[k] = dbAnyStr(v)
		}
		return dbSettingsMsg{params, err}
	}
}

func fetchDBSchedule(cl *api.Client, id string) tea.Cmd {
	return func() tea.Msg {
		var raw struct {
			Cron string `json:"cron"`
		}
		err := cl.GetJSON(context.Background(), dbPath(id)+"/backup-schedule", &raw)
		return dbScheduleMsg{raw.Cron, err}
	}
}

func fetchDBMetrics(cl *api.Client, id string) tea.Cmd {
	return func() tea.Msg {
		var m dbMetricsResp
		err := cl.GetJSON(context.Background(), dbPath(id)+"/metrics", &m)
		return dbMetricsMsg{m, err}
	}
}

func fetchDBProvisioning(cl *api.Client, id string) tea.Cmd {
	return func() tea.Msg {
		var p dbProvisioning
		err := cl.GetJSON(context.Background(), dbPath(id)+"/provisioning", &p)
		if err != nil {
			return dbProvisioningMsg{nil, err}
		}
		return dbProvisioningMsg{&p, nil}
	}
}

func dbAnyStr(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(t)
	default:
		return fmt.Sprint(t)
	}
}

func dbYs(pts []dbXY) []float64 {
	out := make([]float64, len(pts))
	for i, p := range pts {
		out[i] = p.Y
	}
	return out
}

// dbLastY formats the most recent sample of a series, or a dash when empty.
func dbLastY(pts []dbXY, format string) string {
	if len(pts) == 0 {
		return "—"
	}
	return fmt.Sprintf(format, pts[len(pts)-1].Y)
}
