package tui

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/hackclub/orchard/cli/internal/api"
)

func fakeDatabaseAPI(t *testing.T) (*api.Client, *capture) {
	t.Helper()
	cap := &capture{hits: map[string]json.RawMessage{}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io_ReadAll(r)
		cap.mu.Lock()
		cap.hits[r.Method+" "+r.URL.Path] = body
		cap.mu.Unlock()
		p := r.URL.Path
		switch {
		case p == "/apiv1/databases/db1" && r.Method == "GET":
			w.Write([]byte(`{"id":"db1","name":"main","status":"ready","mode":"cnpg","namespace":"proj-ns",
				"storageSize":"1Gi","host":"db.internal","port":5432,"dbName":"maindb","dbUser":"admin",
				"dbPassword":null,"passwordSet":true,"connectionString":"postgresql://admin:****@db.internal:5432/maindb",
				"publicEnabled":false,"cpuRequestMilli":250,"memoryRequestBytes":"268435456","backupsEnabled":true,
				"pods":[{"name":"main-1"}],"liveStatus":{"ready":true,"connections":3,"size":"12 MB"}}`))
		case p == "/apiv1/databases/db1/connection" && r.Method == "GET":
			w.Write([]byte(`{"host":"db.internal","port":5432,"user":"admin","password":"sekret","database":"maindb",
				"connectionString":"postgresql://admin:sekret@db.internal:5432/maindb","publicConnectionString":null}`))
		case strings.HasSuffix(p, "/backups") && r.Method == "GET":
			w.Write([]byte(`[{"id":"b1","label":"nightly","type":"full","status":"completed","sizeBytes":1048576,"createdAt":"2026-07-01"}]`))
		case strings.HasSuffix(p, "/backup-schedule") && r.Method == "GET":
			w.Write([]byte(`{"cron":"0 2 * * *"}`))
		case strings.HasSuffix(p, "/extensions") && r.Method == "GET":
			w.Write([]byte(`{"extensions":[{"name":"pgcrypto","installed":true,"version":"1.3","defaultVersion":"1.3","comment":"crypto"},
				{"name":"ltree","installed":false,"defaultVersion":"1.2","comment":"trees"}],
				"sharedPreloadLibraries":["pg_stat_statements"]}`))
		case strings.HasSuffix(p, "/settings") && r.Method == "GET":
			w.Write([]byte(`{"parameters":{"max_connections":"200","work_mem":"8MB"}}`))
		case strings.HasSuffix(p, "/metrics") && r.Method == "GET":
			w.Write([]byte(`{"data":{"cpu":[{"x":1,"y":12}],"mem":[{"x":1,"y":128}],"rx":[{"x":1,"y":1.5}],"tx":[{"x":1,"y":0.5}]}}`))
		case strings.HasSuffix(p, "/provisioning") && r.Method == "GET":
			w.Write([]byte(`{"databaseId":"db1","status":"provisioning","done":false,"failed":false,"phase":"creating",
				"steps":[{"id":"a","label":"Create cluster","status":"done"},{"id":"b","label":"Start pod","status":"running"}]}`))
		default:
			w.Write([]byte(`{}`))
		}
	}))
	t.Cleanup(srv.Close)
	return api.New(srv.URL, "tok"), cap
}

func loadedDatabaseScreen(t *testing.T, cl *api.Client) screen {
	t.Helper()
	var s screen = newDatabaseScreen(cl, Project{ID: "p1", OrganizationID: "o1"}, "db1", "main")
	s, _ = s.Update(tea.WindowSizeMsg{Width: 120, Height: 40})
	for _, cmd := range []tea.Cmd{
		fetchDBDetail(cl, "db1"), fetchDBBackups(cl, "db1"), fetchDBExtensions(cl, "db1"),
		fetchDBSettings(cl, "db1"), fetchDBSchedule(cl, "db1"), fetchDBMetrics(cl, "db1"),
	} {
		s, _ = s.Update(run(cmd))
	}
	return s
}

func dbKey(s string) tea.KeyMsg { return tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(s)} }

func TestDatabaseScreenTabsRender(t *testing.T) {
	cl, _ := fakeDatabaseAPI(t)
	s := loadedDatabaseScreen(t, cl)

	conn := s.View()
	if !strings.Contains(conn, "db.internal") || !strings.Contains(conn, "maindb") {
		t.Fatalf("connection tab missing host/db:\n%s", conn)
	}
	if strings.Contains(conn, "sekret") {
		t.Fatalf("password should be masked by default:\n%s", conn)
	}
	s, cmd := s.Update(dbKey("r"))
	s, _ = s.Update(run(cmd))
	if v := s.View(); !strings.Contains(v, "sekret") {
		t.Fatalf("r should reveal the password:\n%s", v)
	}

	s, _ = s.Update(dbKey("2"))
	if v := s.View(); !strings.Contains(v, "nightly") || !strings.Contains(v, "0 2 * * *") {
		t.Fatalf("backups tab missing backup/schedule:\n%s", v)
	}
	s, _ = s.Update(dbKey("3"))
	if v := s.View(); !strings.Contains(v, "pgcrypto") || !strings.Contains(v, "pg_stat_statements") {
		t.Fatalf("extensions tab missing extension/preload:\n%s", v)
	}
	s, _ = s.Update(dbKey("4"))
	if v := s.View(); !strings.Contains(v, "12m") || !strings.Contains(v, "Net RX") {
		t.Fatalf("metrics tab missing series:\n%s", v)
	}
	s, _ = s.Update(dbKey("5"))
	if v := s.View(); !strings.Contains(v, "250m") || !strings.Contains(v, "1Gi") {
		t.Fatalf("resources tab missing cpu/storage:\n%s", v)
	}
	s, _ = s.Update(dbKey("6"))
	if v := s.View(); !strings.Contains(v, "max_connections") || !strings.Contains(v, "200") {
		t.Fatalf("settings tab missing parameter:\n%s", v)
	}
}

func TestDatabaseBackupCreateHitsAPI(t *testing.T) {
	cl, cap := fakeDatabaseAPI(t)
	s := loadedDatabaseScreen(t, cl)
	s, _ = s.Update(dbKey("2"))
	_, cmd := s.Update(dbKey("b"))
	if cmd == nil {
		t.Fatal("b on backups tab should trigger the create action")
	}
	if msg, ok := run(cmd).(actionMsg); !ok || msg.err != nil {
		t.Fatalf("backup create failed: %+v", msg)
	}
	cap.mu.Lock()
	_, hit := cap.hits["POST /apiv1/databases/db1/backups"]
	cap.mu.Unlock()
	if !hit {
		t.Fatalf("backup endpoint not hit: %v", cap.hits)
	}
}

func TestDatabaseRestoreConfirms(t *testing.T) {
	cl, cap := fakeDatabaseAPI(t)
	s := loadedDatabaseScreen(t, cl)
	s, _ = s.Update(dbKey("2"))
	s, _ = s.Update(dbKey("R"))
	ds := s.(*databaseScreen)
	if !ds.confirm.Active() {
		t.Fatal("R should arm the confirm modal")
	}
	// n cancels without hitting the API
	s, _ = s.Update(dbKey("n"))
	cap.mu.Lock()
	_, hit := cap.hits["POST /apiv1/databases/db1/restore"]
	cap.mu.Unlock()
	if hit {
		t.Fatal("cancelled restore must not hit the API")
	}
	// y runs the restore with the selected backup id
	s, _ = s.Update(dbKey("R"))
	_, cmd := s.Update(dbKey("y"))
	if cmd == nil {
		t.Fatal("confirming should run the restore command")
	}
	run(cmd)
	cap.mu.Lock()
	body := string(cap.hits["POST /apiv1/databases/db1/restore"])
	cap.mu.Unlock()
	if !strings.Contains(body, `"backupId":"b1"`) {
		t.Fatalf("restore body wrong: %q", body)
	}
}

func TestDatabaseExtensionUninstallConfirms(t *testing.T) {
	cl, cap := fakeDatabaseAPI(t)
	s := loadedDatabaseScreen(t, cl)
	s, _ = s.Update(dbKey("3"))
	s, _ = s.Update(dbKey("x"))
	_, cmd := s.Update(dbKey("y"))
	if cmd == nil {
		t.Fatal("confirming should run the uninstall command")
	}
	run(cmd)
	cap.mu.Lock()
	_, hit := cap.hits["DELETE /apiv1/databases/db1/extensions/pgcrypto"]
	cap.mu.Unlock()
	if !hit {
		t.Fatalf("uninstall endpoint not hit: %v", cap.hits)
	}
}

func TestDatabasePublicEnableConfirms(t *testing.T) {
	cl, cap := fakeDatabaseAPI(t)
	s := loadedDatabaseScreen(t, cl)
	s, _ = s.Update(dbKey("p"))
	ds := s.(*databaseScreen)
	if !ds.confirm.Active() {
		t.Fatal("p should confirm before enabling public access")
	}
	_, cmd := s.Update(dbKey("y"))
	run(cmd)
	cap.mu.Lock()
	_, hit := cap.hits["POST /apiv1/databases/db1/public"]
	cap.mu.Unlock()
	if !hit {
		t.Fatalf("public enable endpoint not hit: %v", cap.hits)
	}
}

func TestDatabaseScheduleScreen(t *testing.T) {
	cl, cap := fakeDatabaseAPI(t)
	// current cron matches the daily preset → cursor starts there
	sc := newDBScheduleScreen(cl, "db1", "0 2 * * *")
	if sc.cursor != 2 {
		t.Fatalf("cursor should start on the daily preset, got %d", sc.cursor)
	}
	_, cmd := sc.submit()
	if res, ok := run(cmd).(formResult); !ok || res.err != nil {
		t.Fatalf("schedule submit failed: %+v", res)
	}
	cap.mu.Lock()
	body := string(cap.hits["PUT /apiv1/databases/db1/backup-schedule"])
	cap.mu.Unlock()
	if !strings.Contains(body, `"cron":"0 2 * * *"`) {
		t.Fatalf("schedule body wrong: %q", body)
	}

	// None → DELETE
	sc2 := newDBScheduleScreen(cl, "db1", "")
	if sc2.cursor != dbSchedNone {
		t.Fatalf("empty cron should start on None, got %d", sc2.cursor)
	}
	_, cmd = sc2.submit()
	run(cmd)
	cap.mu.Lock()
	_, hit := cap.hits["DELETE /apiv1/databases/db1/backup-schedule"]
	cap.mu.Unlock()
	if !hit {
		t.Fatal("None should clear the schedule via DELETE")
	}

	// custom cron round-trips the input value
	sc3 := newDBScheduleScreen(cl, "db1", "*/15 * * * *")
	if sc3.cursor != dbSchedCustom || sc3.cron.Value() != "*/15 * * * *" {
		t.Fatalf("custom cron should prefill the input, got cursor=%d value=%q", sc3.cursor, sc3.cron.Value())
	}
}

func TestDatabaseExtensionInstallForm(t *testing.T) {
	cl, cap := fakeDatabaseAPI(t)
	f := newDBExtInstallScreen(cl, "db1")
	f.fields[0].ti.SetValue("ltree")
	f.fields[1].ti.SetValue("y")
	_, cmd := f.doSubmit()
	if res, ok := run(cmd).(formResult); !ok || res.err != nil {
		t.Fatalf("install submit failed: %+v", res)
	}
	cap.mu.Lock()
	body := string(cap.hits["POST /apiv1/databases/db1/extensions"])
	cap.mu.Unlock()
	if !strings.Contains(body, `"name":"ltree"`) || !strings.Contains(body, `"addToPreload":true`) {
		t.Fatalf("install body wrong: %q", body)
	}
}

func TestDatabaseSettingsEditorSaves(t *testing.T) {
	cl, cap := fakeDatabaseAPI(t)
	e := newDBSettingsScreen(cl, "db1", map[string]string{"work_mem": "8MB"})
	e.ta.SetValue("work_mem=16MB\nmax_connections=300")
	_, cmd := e.submit()
	if res, ok := run(cmd).(formResult); !ok || res.err != nil {
		t.Fatalf("settings submit failed: %+v", res)
	}
	cap.mu.Lock()
	body := string(cap.hits["PATCH /apiv1/databases/db1/settings"])
	cap.mu.Unlock()
	if !strings.Contains(body, `"work_mem":"16MB"`) || !strings.Contains(body, `"max_connections":"300"`) {
		t.Fatalf("settings body wrong: %q", body)
	}
}

func TestDatabaseResourcesFormBody(t *testing.T) {
	cl, cap := fakeDatabaseAPI(t)
	d := &dbDetail{CPURequestMilli: 250, MemoryRequestB: 268435456}
	f := newDBResourcesScreen(cl, "db1", d)
	if f.fields[0].ti.Value() != "250" || f.fields[1].ti.Value() != "256Mi" {
		t.Fatalf("resources form not prefilled: %q / %q", f.fields[0].ti.Value(), f.fields[1].ti.Value())
	}
	f.fields[0].ti.SetValue("500")
	f.fields[1].ti.SetValue("1Gi")
	_, cmd := f.doSubmit()
	if res, ok := run(cmd).(formResult); !ok || res.err != nil {
		t.Fatalf("resources submit failed: %+v", res)
	}
	cap.mu.Lock()
	body := string(cap.hits["PATCH /apiv1/databases/db1/resources"])
	cap.mu.Unlock()
	if !strings.Contains(body, `"cpuRequestMilli":500`) || !strings.Contains(body, `"memoryRequestBytes":1073741824`) {
		t.Fatalf("resources body wrong: %q", body)
	}
}

func TestDatabaseStorageExpandBody(t *testing.T) {
	cl, cap := fakeDatabaseAPI(t)
	f := newDBStorageScreen(cl, "db1", "1Gi")
	f.fields[0].ti.SetValue("10Gi")
	_, cmd := f.doSubmit()
	run(cmd)
	cap.mu.Lock()
	body := string(cap.hits["PATCH /apiv1/databases/db1/storage"])
	cap.mu.Unlock()
	if !strings.Contains(body, `"storageSize":"10Gi"`) {
		t.Fatalf("storage body wrong: %q", body)
	}
}

func TestDatabaseOnOrgEventRefetches(t *testing.T) {
	cl, _ := fakeDatabaseAPI(t)
	ds := newDatabaseScreen(cl, Project{OrganizationID: "o1"}, "db1", "main")
	if ds.OnOrgEvent(api.OrgEvent{Type: "database.changed", ID: "db1"}) == nil {
		t.Fatal("database.changed for this id should refetch")
	}
	if ds.OnOrgEvent(api.OrgEvent{Type: "database.changed", ID: "other"}) != nil {
		t.Fatal("events for other entities should be ignored")
	}
	if ds.orgID() != "o1" {
		t.Fatalf("orgID should come from the project, got %q", ds.orgID())
	}
}

func TestDatabaseProvisioningBanner(t *testing.T) {
	cl, _ := fakeDatabaseAPI(t)
	var s screen = newDatabaseScreen(cl, Project{}, "db1", "main")
	s, _ = s.Update(tea.WindowSizeMsg{Width: 120, Height: 40})
	d := &dbDetail{ID: "db1", Status: "provisioning", Mode: "cnpg"}
	s, cmd := s.Update(dbDetailMsg{d: d})
	if cmd == nil {
		t.Fatal("a provisioning detail should trigger a provisioning fetch")
	}
	s, _ = s.Update(run(fetchDBProvisioning(cl, "db1")))
	v := s.View()
	if !strings.Contains(v, "PROVISIONING") || !strings.Contains(v, "1/2 steps") || !strings.Contains(v, "Start pod") {
		t.Fatalf("provisioning banner missing:\n%s", v)
	}
}

func TestDatabaseShellNeedsPod(t *testing.T) {
	cl, _ := fakeDatabaseAPI(t)
	ds := newDatabaseScreen(cl, Project{}, "db1", "main")
	ds.detail = &dbDetail{Status: "provisioning"}
	msg := run(ds.openShell())
	fl, ok := msg.(flash)
	if !ok || !fl.isErr || !strings.Contains(fl.text, "no running pod") {
		t.Fatalf("shell without pod should flash an error, got %#v", msg)
	}
}

func TestProjectEnterOpensDatabase(t *testing.T) {
	cl, _ := fakeAPI(t)
	var s screen = newProjectScreen(cl, Project{ID: "p1", Name: "web-app"})
	s, _ = s.Update(tea.WindowSizeMsg{Width: 120, Height: 40})
	s, _ = s.Update(deploymentsMsg{items: mustDeps(cl)})
	s, _ = s.Update(databasesMsg{items: mustDBs(cl)})
	s, _ = s.Update(tea.KeyMsg{Type: tea.KeyTab}) // focus databases
	_, cmd := s.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd == nil {
		t.Fatal("enter on a database row should push the database screen")
	}
	pushed, ok := run(cmd).(pushScreen)
	if !ok {
		t.Fatal("expected a pushScreen navigation")
	}
	if _, ok := pushed.s.(*databaseScreen); !ok {
		t.Fatalf("expected a *databaseScreen, got %T", pushed.s)
	}
}
