package tui

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"

	"github.com/hackclub/orchard/cli/internal/api"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

var orgTabs = []string{"General", "Members", "Notifications", "Backups", "Audit"}

// ---- data ----

type orgDetail struct {
	ID               string `json:"id"`
	Name             string `json:"name"`
	Slug             string `json:"slug"`
	Plan             string `json:"plan"`
	Subdomain        string `json:"subdomain"`
	Description      string `json:"description"`
	DatabasePublicIP string `json:"databasePublicIp"`
	CreatedAt        string `json:"createdAt"`
}

type orgMember struct {
	ID      string `json:"id"`
	Role    string `json:"role"`
	AddedAt string `json:"addedAt"`
	User    struct {
		Email     string `json:"email"`
		Username  string `json:"username"`
		FirstName string `json:"firstName"`
		LastName  string `json:"lastName"`
	} `json:"user"`
}

func (m orgMember) displayName() string {
	if name := strings.TrimSpace(m.User.FirstName + " " + m.User.LastName); name != "" {
		return name
	}
	if m.User.Username != "" {
		return m.User.Username
	}
	return m.User.Email
}

type notifyChannel struct {
	ID         string   `json:"id"`
	Type       string   `json:"type"`
	Name       string   `json:"name"`
	Enabled    bool     `json:"enabled"`
	Events     []string `json:"events"`
	ProjectIDs []string `json:"projectIds"`
}

type backupSettings struct {
	Endpoint            string `json:"endpoint"`
	Bucket              string `json:"bucket"`
	Region              string `json:"region"`
	AccessKeyConfigured bool   `json:"accessKeyConfigured"`
	AccessKeyLast4      string `json:"accessKeyLast4"`
	SecretKeyConfigured bool   `json:"secretKeyConfigured"`
	DatabasePublicIP    string `json:"databasePublicIp"`
}

type auditEntry struct {
	ID          string `json:"id"`
	CreatedAt   string `json:"createdAt"`
	Action      string `json:"action"`
	ActorEmail  string `json:"actorEmail"`
	TargetType  string `json:"targetType"`
	TargetID    string `json:"targetId"`
	TargetLabel string `json:"targetLabel"`
	Actor       *struct {
		Username  string `json:"username"`
		Email     string `json:"email"`
		FirstName string `json:"firstName"`
		LastName  string `json:"lastName"`
	} `json:"actor"`
	Metadata json.RawMessage `json:"metadata"`
}

func (e auditEntry) actorName() string {
	if e.Actor != nil {
		if e.Actor.Username != "" {
			return e.Actor.Username
		}
		if e.Actor.Email != "" {
			return e.Actor.Email
		}
		if name := strings.TrimSpace(e.Actor.FirstName + " " + e.Actor.LastName); name != "" {
			return name
		}
	}
	if e.ActorEmail != "" {
		return e.ActorEmail
	}
	return "system"
}

func (e auditEntry) target() string {
	label := e.TargetLabel
	if label == "" {
		label = e.TargetID
	}
	switch {
	case e.TargetType != "" && label != "":
		return e.TargetType + " " + label
	case label != "":
		return label
	default:
		return e.TargetType
	}
}

// ---- messages + fetchers (endpoints mirror cmd/org.go, member.go, notify.go, audit.go) ----

type (
	orgDetailMsg struct {
		org orgDetail
		err error
	}
	orgMembersMsg struct {
		items []orgMember
		err   error
	}
	orgChannelsMsg struct {
		items []notifyChannel
		err   error
	}
	orgBackupMsg struct {
		s   backupSettings
		err error
	}
	orgAuditMsg struct {
		entries []auditEntry
		err     error
	}
)

func orgPath(orgID string, rest ...string) string {
	p := "/organizations/" + url.PathEscape(orgID)
	for _, r := range rest {
		p += "/" + url.PathEscape(r)
	}
	return p
}

func fetchOrgDetail(cl *api.Client, orgID string) tea.Cmd {
	return func() tea.Msg {
		var o orgDetail
		err := cl.GetJSON(context.Background(), orgPath(orgID), &o)
		return orgDetailMsg{o, err}
	}
}

func fetchOrgMembers(cl *api.Client, orgID string) tea.Cmd {
	return func() tea.Msg {
		items, err := getList[orgMember](cl, orgPath(orgID, "members"))
		return orgMembersMsg{items, err}
	}
}

func fetchOrgChannels(cl *api.Client, orgID string) tea.Cmd {
	return func() tea.Msg {
		items, err := getList[notifyChannel](cl, orgPath(orgID, "notification-channels"))
		return orgChannelsMsg{items, err}
	}
}

func fetchOrgBackup(cl *api.Client, orgID string) tea.Cmd {
	return func() tea.Msg {
		var s backupSettings
		err := cl.GetJSON(context.Background(), orgPath(orgID, "backup-settings"), &s)
		return orgBackupMsg{s, err}
	}
}

func fetchOrgAudit(cl *api.Client, orgID string) tea.Cmd {
	return func() tea.Msg {
		var raw struct {
			Entries []auditEntry `json:"entries"`
		}
		err := cl.GetJSON(context.Background(), "/audit-logs/organization/"+url.PathEscape(orgID)+"?limit=50", &raw)
		return orgAuditMsg{raw.Entries, err}
	}
}

// ---- actions ----

func inviteMemberForm(cl *api.Client, orgID string) *formScreen {
	return newForm("Invite member",
		"Sends an email invitation (expires after 7 days). Roles: owner, admin, member.",
		[]*field{
			fld("email", "Email", "person@example.com", true),
			fld("role", "Role", "member", false),
		},
		func(v map[string]string) tea.Cmd {
			return func() tea.Msg {
				role := v["role"]
				if role == "" {
					role = "member"
				}
				switch role {
				case "owner", "admin", "member":
				default:
					return formResult{err: errInvalid("role must be owner, admin, or member")}
				}
				err := cl.Send(context.Background(), "POST", orgPath(orgID, "members"),
					map[string]any{"email": v["email"], "role": role}, nil)
				return formResult{ok: actionMsg{text: "sent invitation to " + v["email"]}, err: err}
			}
		})
}

func setRoleForm(cl *api.Client, orgID string, m orgMember) *formScreen {
	f := fld("role", "Role", m.Role, true)
	f.ti.SetValue(m.Role)
	return newForm("Set role — "+m.displayName(),
		"Roles: owner, admin, member, guest (owner-only on the server).",
		[]*field{f},
		func(v map[string]string) tea.Cmd {
			return func() tea.Msg {
				switch v["role"] {
				case "owner", "admin", "member", "guest":
				default:
					return formResult{err: errInvalid("role must be owner, admin, member, or guest")}
				}
				err := cl.Send(context.Background(), "PATCH", orgPath(orgID, "members", m.ID),
					map[string]any{"role": v["role"]}, nil)
				return formResult{ok: actionMsg{text: m.displayName() + " is now " + v["role"]}, err: err}
			}
		})
}

func renameOrgForm(cl *api.Client, org orgDetail) *formScreen {
	f := fld("name", "Name", org.Name, true)
	f.ti.SetValue(org.Name)
	return newForm("Rename organization",
		"Display name only; the slug and subdomain are unchanged.",
		[]*field{f},
		func(v map[string]string) tea.Cmd {
			return func() tea.Msg {
				err := cl.Send(context.Background(), "PATCH", orgPath(org.ID),
					map[string]any{"name": v["name"]}, nil)
				return formResult{ok: actionMsg{text: "renamed organization to " + v["name"]}, err: err}
			}
		})
}

func removeMember(cl *api.Client, orgID string, m orgMember) tea.Cmd {
	return func() tea.Msg {
		err := cl.Send(context.Background(), "DELETE", orgPath(orgID, "members", m.ID), nil, nil)
		return actionMsg{"removed " + m.displayName(), err}
	}
}

func toggleChannel(cl *api.Client, orgID string, ch notifyChannel) tea.Cmd {
	enable := !ch.Enabled
	return func() tea.Msg {
		err := cl.Send(context.Background(), "PATCH", orgPath(orgID, "notification-channels", ch.ID),
			map[string]any{"enabled": enable}, nil)
		text := "enabled " + ch.Name
		if !enable {
			text = "disabled " + ch.Name
		}
		return actionMsg{text, err}
	}
}

func testChannel(cl *api.Client, orgID string, ch notifyChannel) tea.Cmd {
	return func() tea.Msg {
		var raw map[string]any
		err := cl.Send(context.Background(), "POST",
			orgPath(orgID, "notification-channels", ch.ID)+"/test", nil, &raw)
		if err == nil {
			if ok, _ := raw["success"].(bool); !ok {
				msg, _ := raw["error"].(string)
				if msg == "" {
					msg = "unknown error"
				}
				err = errInvalid("test delivery failed: " + msg)
			}
		}
		return actionMsg{"test notification sent via " + ch.Name, err}
	}
}

// ---- screen ----

type orgSettingsScreen struct {
	cl  *api.Client
	id  string
	tab int

	org      orgDetail
	members  []orgMember
	channels []notifyChannel
	backup   backupSettings
	audit    []auditEntry
	tabErr   [5]error

	memCursor  int
	chCursor   int
	auCursor   int
	auOpen     bool
	tabSpans   [][2]int
	hitMembers hitTable
	confirm    confirmModel
	loading    bool
	w, h       int
}

func newOrgSettingsScreen(cl *api.Client, orgID string) *orgSettingsScreen {
	return &orgSettingsScreen{cl: cl, id: orgID, loading: true}
}

func (s *orgSettingsScreen) title() string { return "Org settings" }

func (s *orgSettingsScreen) orgID() string { return s.id }

func (s *orgSettingsScreen) grabsKeys() bool { return s.confirm.Active() }

func (s *orgSettingsScreen) Init() tea.Cmd {
	return tea.Batch(
		fetchOrgDetail(s.cl, s.id),
		fetchOrgMembers(s.cl, s.id),
		fetchOrgChannels(s.cl, s.id),
		fetchOrgBackup(s.cl, s.id),
		fetchOrgAudit(s.cl, s.id),
	)
}

// refreshTab refetches only the data behind the active tab.
func (s *orgSettingsScreen) refreshTab() tea.Cmd {
	switch s.tab {
	case 0:
		return fetchOrgDetail(s.cl, s.id)
	case 1:
		return fetchOrgMembers(s.cl, s.id)
	case 2:
		return fetchOrgChannels(s.cl, s.id)
	case 3:
		return fetchOrgBackup(s.cl, s.id)
	default:
		return fetchOrgAudit(s.cl, s.id)
	}
}

func (s *orgSettingsScreen) help() []keyHint {
	if s.confirm.Active() {
		return s.confirm.help()
	}
	h := []keyHint{{"←/→", "tabs"}}
	switch s.tab {
	case 0:
		h = append(h, keyHint{"e", "edit name"})
	case 1:
		h = append(h, keyHint{"↑/↓", "move"}, keyHint{"i", "invite"}, keyHint{"m", "set role"}, keyHint{"x", "remove"})
	case 2:
		h = append(h, keyHint{"↑/↓", "move"}, keyHint{"e", "enable/disable"}, keyHint{"t", "test"})
	case 4:
		h = append(h, keyHint{"↑/↓", "move"}, keyHint{"enter", "details"})
	}
	return append(h, keyHint{"r", "refresh"}, keyHint{"esc", "back"})
}

func (s *orgSettingsScreen) Update(msg tea.Msg) (screen, tea.Cmd) {
	if handled, cmd := s.confirm.Update(msg); handled {
		return s, cmd
	}
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		s.w, s.h = msg.Width, msg.Height
	case orgDetailMsg:
		s.loading = false
		s.tabErr[0] = msg.err
		if msg.err == nil {
			s.org = msg.org
		}
	case orgMembersMsg:
		s.tabErr[1] = msg.err
		s.members = msg.items
		if s.memCursor >= len(s.members) {
			s.memCursor = 0
		}
	case orgChannelsMsg:
		s.tabErr[2] = msg.err
		s.channels = msg.items
		if s.chCursor >= len(s.channels) {
			s.chCursor = 0
		}
	case orgBackupMsg:
		s.tabErr[3] = msg.err
		if msg.err == nil {
			s.backup = msg.s
		}
	case orgAuditMsg:
		s.tabErr[4] = msg.err
		s.audit = msg.entries
		if s.auCursor >= len(s.audit) {
			s.auCursor = 0
		}
	case actionMsg:
		if msg.err != nil {
			return s, errFlash(msg.err)
		}
		return s, tea.Batch(s.refreshTab(), flashf("%s", msg.text))
	case tea.MouseMsg:
		if msg.Button == tea.MouseButtonLeft && msg.Action == tea.MouseActionPress {
			if msg.Y == 1 {
				for i, sp := range s.tabSpans {
					if msg.X >= sp[0] && msg.X <= sp[1] {
						s.tab = i
						return s, nil
					}
				}
			}
			if s.tab == 1 {
				if idx := s.hitMembers.rowAt(msg.X, msg.Y, s.memCursor); idx >= 0 {
					s.memCursor = idx
				}
			}
		}
		switch msg.Button {
		case tea.MouseButtonWheelUp:
			s.move(-1)
		case tea.MouseButtonWheelDown:
			s.move(1)
		}
	case tea.KeyMsg:
		switch msg.String() {
		case "esc":
			return s, pop
		case "tab", "right", "l":
			s.tab = (s.tab + 1) % len(orgTabs)
		case "left", "h":
			s.tab = (s.tab - 1 + len(orgTabs)) % len(orgTabs)
		case "1", "2", "3", "4", "5":
			s.tab = int(msg.String()[0] - '1')
		case "r":
			return s, s.refreshTab()
		case "up", "k":
			s.move(-1)
		case "down", "j":
			s.move(1)
		case "e":
			if s.tab == 0 && s.org.ID != "" {
				return s, push(renameOrgForm(s.cl, s.org))
			}
			if s.tab == 2 && s.chCursor < len(s.channels) {
				return s, toggleChannel(s.cl, s.id, s.channels[s.chCursor])
			}
		case "t":
			if s.tab == 2 && s.chCursor < len(s.channels) {
				return s, testChannel(s.cl, s.id, s.channels[s.chCursor])
			}
		case "i":
			if s.tab == 1 {
				return s, push(inviteMemberForm(s.cl, s.id))
			}
		case "m":
			if s.tab == 1 && s.memCursor < len(s.members) {
				return s, push(setRoleForm(s.cl, s.id, s.members[s.memCursor]))
			}
		case "x":
			if s.tab == 1 && s.memCursor < len(s.members) {
				m := s.members[s.memCursor]
				s.confirm.Show(fmt.Sprintf("Remove %s from the organization and all of its projects?", m.displayName()),
					removeMember(s.cl, s.id, m))
			}
		case "enter":
			if s.tab == 4 && len(s.audit) > 0 {
				s.auOpen = !s.auOpen
			}
		}
	}
	return s, nil
}

// move shifts the active tab's cursor by d.
func (s *orgSettingsScreen) move(d int) {
	shift := func(cur *int, n int) {
		if n == 0 {
			return
		}
		*cur += d
		if *cur < 0 {
			*cur = 0
		}
		if *cur >= n {
			*cur = n - 1
		}
	}
	switch s.tab {
	case 1:
		shift(&s.memCursor, len(s.members))
	case 2:
		shift(&s.chCursor, len(s.channels))
	case 4:
		shift(&s.auCursor, len(s.audit))
	}
}

func roleBadge(role string) string {
	c := colMuted
	switch role {
	case "owner":
		c = colAccent
	case "admin":
		c = colYellow
	case "member":
		c = colGreen
	}
	return lipgloss.NewStyle().Foreground(lipgloss.Color(c)).Bold(true).Render(role)
}

// shortTS trims an ISO timestamp to "YYYY-MM-DD HH:MM".
func shortTS(ts string) string {
	if len(ts) >= 16 {
		return strings.Replace(ts[:16], "T", " ", 1)
	}
	return ts
}

func (s *orgSettingsScreen) View() string {
	return s.confirm.Overlay(s.view(), s.w, s.h-chromeH)
}

func (s *orgSettingsScreen) view() string {
	if s.loading && s.org.ID == "" {
		return stMuted.Render("\n  loading organization…")
	}
	bodyH := s.h - chromeH
	strip := renderTabs(orgTabs, s.tab)

	spans := make([][2]int, len(orgTabs))
	x := 4
	for i, t := range orgTabs {
		spans[i] = [2]int{x, x + len(t) - 1}
		x += len(t) + 3
	}
	s.tabSpans = spans

	if err := s.tabErr[s.tab]; err != nil {
		return panelRaw(strip, stRed.Render("✗ "+err.Error()), s.w, bodyH, true)
	}

	switch s.tab {
	case 0:
		return panelRaw(strip, s.viewGeneral(), s.w, bodyH, true)
	case 1:
		s.hitMembers = hitTable{topY: 4, visible: bodyH - 4, count: len(s.members), minX: 0, maxX: s.w - 1}
		return panelRaw(strip, s.viewMembers(bodyH), s.w, bodyH, true)
	case 2:
		return panelRaw(strip, s.viewChannels(bodyH), s.w, bodyH, true)
	case 3:
		return panelRaw(strip, s.viewBackups(), s.w, bodyH, true)
	default:
		return s.viewAudit(bodyH, strip)
	}
}

func (s *orgSettingsScreen) viewGeneral() string {
	var b strings.Builder
	kv := func(k, v string) {
		if v == "" {
			v = stMuted.Render("—")
		}
		b.WriteString(stKey.Render(pad(k, 12)) + " " + v + "\n")
	}
	b.WriteString(stTitle.Render(s.org.Name) + "\n\n")
	kv("Slug", stMuted.Render(s.org.Slug))
	kv("Subdomain", s.org.Subdomain)
	kv("Plan", s.org.Plan)
	kv("Public IP", s.org.DatabasePublicIP)
	kv("Created", shortTS(s.org.CreatedAt))
	if s.org.Description != "" {
		b.WriteString("\n" + stMuted.Render(s.org.Description) + "\n")
	}
	b.WriteString("\n" + stFooter.Render("press e to edit the display name"))
	return b.String()
}

func (s *orgSettingsScreen) viewMembers(height int) string {
	rows := make([][]string, len(s.members))
	for i, m := range s.members {
		rows[i] = []string{
			m.displayName(),
			stMuted.Render(m.User.Email),
			roleBadge(m.Role),
			stMuted.Render(shortTS(m.AddedAt)),
		}
	}
	cols := []col{{title: "MEMBER"}, {title: "EMAIL"}, {title: "ROLE"}, {title: "JOINED"}}
	return renderTable(cols, rows, s.memCursor, s.w-2, height-2)
}

func (s *orgSettingsScreen) viewChannels(height int) string {
	rows := make([][]string, len(s.channels))
	for i, ch := range s.channels {
		enabled := stGreen.Render("● enabled")
		if !ch.Enabled {
			enabled = stMuted.Render("○ disabled")
		}
		scope := "all projects"
		if n := len(ch.ProjectIDs); n == 1 {
			scope = "1 project"
		} else if n > 1 {
			scope = fmt.Sprintf("%d projects", n)
		}
		rows[i] = []string{
			ch.Name,
			stMuted.Render(ch.Type),
			enabled,
			fmt.Sprintf("%d", len(ch.Events)),
			stMuted.Render(scope),
		}
	}
	cols := []col{{title: "NAME"}, {title: "TYPE"}, {title: "STATUS"}, {title: "EVENTS"}, {title: "SCOPE"}}
	return renderTable(cols, rows, s.chCursor, s.w-2, height-2)
}

func (s *orgSettingsScreen) viewBackups() string {
	var b strings.Builder
	kv := func(k, v string) {
		if v == "" {
			v = stMuted.Render("not set")
		}
		b.WriteString(stKey.Render(pad(k, 12)) + " " + v + "\n")
	}
	b.WriteString(stTitle.Render("Database backup storage (R2)") + "\n\n")
	kv("Endpoint", s.backup.Endpoint)
	kv("Bucket", s.backup.Bucket)
	kv("Region", s.backup.Region)
	access := ""
	if s.backup.AccessKeyConfigured {
		access = "configured"
		if s.backup.AccessKeyLast4 != "" {
			access = "configured (ends in " + s.backup.AccessKeyLast4 + ")"
		}
	}
	kv("Access key", access)
	secret := ""
	if s.backup.SecretKeyConfigured {
		secret = "configured"
	}
	kv("Secret key", secret)
	kv("Public IP", s.backup.DatabasePublicIP)
	b.WriteString("\n" + stFooter.Render("edit with `orchard org backup-settings set`"))
	return b.String()
}

func (s *orgSettingsScreen) viewAudit(height int, strip string) string {
	listH := height
	if s.auOpen {
		listH = height / 2
		if listH < 5 {
			listH = 5
		}
	}
	rows := make([][]string, len(s.audit))
	for i, e := range s.audit {
		rows[i] = []string{
			stMuted.Render(shortTS(e.CreatedAt)),
			e.actorName(),
			stKey.Render(e.Action),
			stMuted.Render(e.target()),
		}
	}
	cols := []col{{title: "TS"}, {title: "ACTOR"}, {title: "ACTION"}, {title: "TARGET"}}
	table := renderTable(cols, rows, s.auCursor, s.w-2, listH-2)
	top := panelRaw(strip, table, s.w, listH, true)
	if !s.auOpen {
		return top
	}
	return top + "\n" + panel("Entry", s.auditDetail(), s.w, height-listH, false)
}

func (s *orgSettingsScreen) auditDetail() string {
	if s.auCursor >= len(s.audit) {
		return stMuted.Render("no entry selected")
	}
	e := s.audit[s.auCursor]
	var b strings.Builder
	kv := func(k, v string) {
		if v == "" {
			return
		}
		b.WriteString(stKey.Render(pad(k, 10)) + " " + v + "\n")
	}
	kv("Action", stTitle.Render(e.Action))
	kv("When", shortTS(e.CreatedAt))
	kv("Actor", e.actorName())
	kv("Target", e.target())
	kv("Entry ID", stMuted.Render(e.ID))
	if len(e.Metadata) > 0 && string(e.Metadata) != "null" {
		var meta any
		if err := json.Unmarshal(e.Metadata, &meta); err == nil {
			if pretty, err := json.MarshalIndent(meta, "", "  "); err == nil {
				b.WriteString(stKey.Render("Metadata") + "\n" + stMuted.Render(string(pretty)))
			}
		}
	}
	return b.String()
}
