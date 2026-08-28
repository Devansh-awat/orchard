package tui

import (
	"fmt"

	"github.com/hackclub/orchard/cli/internal/api"
	tea "github.com/charmbracelet/bubbletea"
)

type deploymentsMsg struct {
	items []Deployment
	err   error
}
type databasesMsg struct {
	items []Database
	err   error
}

func fetchDeployments(cl *api.Client, projectID string) tea.Cmd {
	return func() tea.Msg {
		items, err := getList[Deployment](cl, "/projects/"+projectID+"/deployments")
		return deploymentsMsg{items, err}
	}
}
func fetchDatabases(cl *api.Client, projectID string) tea.Cmd {
	return func() tea.Msg {
		items, err := getList[Database](cl, "/projects/"+projectID+"/databases")
		return databasesMsg{items, err}
	}
}

type projectScreen struct {
	cl      *api.Client
	project Project
	deps    []Deployment
	dbs     []Database
	focus   int // 0 = deployments, 1 = databases
	dCursor int
	bCursor int
	depsErr error
	dbsErr  error
	hitDep  hitTable
	hitDb   hitTable
	loading bool
	w, h    int
}

func newProjectScreen(cl *api.Client, p Project) *projectScreen {
	return &projectScreen{cl: cl, project: p, loading: true}
}

func (s *projectScreen) title() string { return s.project.Name }

func (s *projectScreen) Init() tea.Cmd {
	return tea.Batch(fetchDeployments(s.cl, s.project.ID), fetchDatabases(s.cl, s.project.ID))
}

func (s *projectScreen) refresh() tea.Cmd {
	s.loading = true
	return s.Init()
}

func (s *projectScreen) Update(msg tea.Msg) (screen, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		s.w, s.h = msg.Width, msg.Height
	case deploymentsMsg:
		s.loading = false
		s.deps, s.depsErr = msg.items, msg.err
	case databasesMsg:
		s.dbs, s.dbsErr = msg.items, msg.err
	case createdMsg:
		return s, tea.Batch(s.refresh(), flashf("%s", msg.text))
	case tea.MouseMsg:
		switch msg.Button {
		case tea.MouseButtonWheelUp:
			if s.focus == 0 && s.dCursor > 0 {
				s.dCursor--
			} else if s.focus == 1 && s.bCursor > 0 {
				s.bCursor--
			}
		case tea.MouseButtonWheelDown:
			if s.focus == 0 && s.dCursor < len(s.deps)-1 {
				s.dCursor++
			} else if s.focus == 1 && s.bCursor < len(s.dbs)-1 {
				s.bCursor++
			}
		case tea.MouseButtonLeft:
			if msg.Action == tea.MouseActionPress {
				if idx := s.hitDep.rowAt(msg.X, msg.Y, s.dCursor); idx >= 0 {
					if s.focus == 0 && idx == s.dCursor {
						return s, push(newDeploymentScreen(s.cl, s.project, s.deps[idx].ID, s.deps[idx].Name))
					}
					s.focus, s.dCursor = 0, idx
				} else if idx := s.hitDb.rowAt(msg.X, msg.Y, s.bCursor); idx >= 0 {
					s.focus, s.bCursor = 1, idx
				}
			}
		}
	case tea.KeyMsg:
		switch msg.String() {
		case "esc":
			return s, pop
		case "tab":
			s.focus = 1 - s.focus
		case "up", "k":
			if s.focus == 0 && s.dCursor > 0 {
				s.dCursor--
			} else if s.focus == 1 && s.bCursor > 0 {
				s.bCursor--
			}
		case "down", "j":
			if s.focus == 0 && s.dCursor < len(s.deps)-1 {
				s.dCursor++
			} else if s.focus == 1 && s.bCursor < len(s.dbs)-1 {
				s.bCursor++
			}
		case "r":
			return s, s.refresh()
		case "n":
			return s, push(newDeployMenuScreen(s.cl, s.project))
		case "d":
			return s, push(newDatabaseFormScreen(s.cl, s.project))
		case "J":
			return s, push(newJobsListScreen(s.cl, s.project.OrganizationID, s.project.ID))
		case "O":
			return s, push(newOrgSettingsScreen(s.cl, s.project.OrganizationID))
		case "enter":
			if s.focus == 0 && s.dCursor < len(s.deps) {
				return s, push(newDeploymentScreen(s.cl, s.project, s.deps[s.dCursor].ID, s.deps[s.dCursor].Name))
			}
			if s.focus == 1 && s.bCursor < len(s.dbs) {
				return s, push(newDatabaseScreen(s.cl, s.project, s.dbs[s.bCursor].ID, s.dbs[s.bCursor].Name))
			}
		}
	}
	return s, nil
}

func (s *projectScreen) View() string {
	if s.loading {
		return stMuted.Render("\n  loading…")
	}
	availH := s.h - chromeH
	half := availH / 2
	if half < 3 {
		half = 3
	}

	depRows := make([][]string, len(s.deps))
	for i, d := range s.deps {
		st := d.Status
		if d.BuildStatus == "building" {
			st = "building"
		}
		depRows[i] = []string{
			d.Name,
			statusDot(st),
			fmt.Sprintf("%d/%d", d.AvailableReplicas, d.Replicas),
			stMuted.Render(truncate(d.Image, 40)),
		}
	}
	dbRows := make([][]string, len(s.dbs))
	for i, d := range s.dbs {
		dbRows[i] = []string{d.Name, statusDot(d.Status), stMuted.Render(d.Mode)}
	}

	depCursor, dbCursor := s.dCursor, s.bCursor
	if s.focus != 0 {
		depCursor = -1
	}
	if s.focus != 1 {
		dbCursor = -1
	}

	depBody := sectionErr(s.depsErr)
	if depBody == "" {
		depBody = renderTable([]col{{title: "NAME"}, {title: "STATUS"}, {title: "REPLICAS"}, {title: "IMAGE"}},
			depRows, depCursor, s.w-2, half-2)
	}
	dbBody := sectionErr(s.dbsErr)
	if dbBody == "" {
		dbBody = renderTable([]col{{title: "NAME"}, {title: "STATUS"}, {title: "MODE"}}, dbRows, dbCursor, s.w-2, half-2)
	}

	dep := panel(fmt.Sprintf("Deployments (%d)", len(s.deps)), depBody, s.w, half, s.focus == 0)
	db := panel(fmt.Sprintf("Databases (%d)", len(s.dbs)), dbBody, s.w, availH-half, s.focus == 1)

	// click geometry: dep panel starts at body top (abs Y 1), db panel below it
	s.hitDep = hitTable{topY: 4, visible: half - 4, count: len(s.deps), minX: 0, maxX: s.w - 1}
	s.hitDb = hitTable{topY: half + 4, visible: (availH - half) - 4, count: len(s.dbs), minX: 0, maxX: s.w - 1}
	return dep + "\n" + db
}

func (s *projectScreen) help() []keyHint {
	return []keyHint{{"tab", "switch"}, {"↑/↓", "move"}, {"enter", "open"},
		{"n", "deploy"}, {"d", "database"}, {"J", "jobs"}, {"O", "org settings"},
		{"r", "refresh"}, {"esc", "back"}}
}

func sectionErr(err error) string {
	if err == nil {
		return ""
	}
	return "  " + stRed.Render("✗ "+err.Error())
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	if n <= 1 {
		return s[:n]
	}
	return s[:n-1] + "…"
}
