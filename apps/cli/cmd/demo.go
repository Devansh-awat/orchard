package cmd

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"

	"github.com/LeafdTK/leaf/cli/internal/api"
)

// demoServer serves canned data so `orchard ui --demo` can be explored offline,
// without auth or a live backend. Handy for seeing the dashboard at a glance.
func demoServer() *httptest.Server {
	json := func(s string) []byte { return []byte(s) }
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		switch {
		case p == "/apiv1/auth/me":
			w.Write(json(`{"email":"raven@hackclub.com"}`))
		case p == "/apiv1/projects" && r.Method == "GET":
			w.Write(json(`[
			  {"id":"p1","name":"orchard-web","slug":"orchard-web","organization":{"slug":"hackclub"},"_count":{"deployments":3,"databases":1}},
			  {"id":"p2","name":"paste-bin","slug":"paste","organization":{"slug":"hackclub"},"_count":{"deployments":1,"databases":1}},
			  {"id":"p3","name":"metrics-relay","slug":"metrics","organization":{"slug":"infra"},"_count":{"deployments":2,"databases":0}}
			]`))
		case p == "/apiv1/organizations/user":
			w.Write(json(`[{"id":"o1","name":"Hack Club","slug":"hackclub"},{"id":"o2","name":"Infra","slug":"infra"}]`))
		case strings.HasSuffix(p, "/deployments") && r.Method == "GET":
			w.Write(json(`[
			  {"id":"d1","name":"frontend","status":"running","buildStatus":"success","replicas":3,"availableReplicas":3,"image":"ghcr.io/hackclub/leaf-frontend:latest"},
			  {"id":"d2","name":"api","status":"running","replicas":2,"availableReplicas":2,"image":"ghcr.io/hackclub/leaf-server:latest"},
			  {"id":"d3","name":"worker","status":"building","buildStatus":"building","replicas":1,"availableReplicas":0,"image":"ghcr.io/hackclub/leaf-worker:latest"}
			]`))
		case strings.HasSuffix(p, "/databases") && r.Method == "GET":
			w.Write(json(`[{"id":"db1","name":"primary","status":"ready","mode":"cnpg"}]`))
		case strings.Contains(p, "/deployments/") && strings.HasSuffix(p, "/pods"):
			w.Write(json(`[
			  {"name":"frontend-7c9d-abc","status":"Running","ready":"1/1","restartCount":0,"nodeName":"node-a","age":"4h"},
			  {"name":"frontend-7c9d-def","status":"Running","ready":"1/1","restartCount":1,"nodeName":"node-b","age":"4h"},
			  {"name":"frontend-7c9d-ghi","status":"CrashLoopBackOff","ready":"0/1","restartCount":7,"nodeName":"node-b","age":"12m"}
			]`))
		case strings.Contains(p, "/deployments/") && strings.HasSuffix(p, "/metrics"):
			w.Write(json(metricsFixture()))
		case strings.Contains(p, "/deployments/") && strings.HasSuffix(p, "/logs"):
			w.Write(json(`{"logs":"#1 [internal] load build definition\n#5 building image\n#9 exporting layers\n#12 DONE 2.4s","status":"running"}`))
		case strings.HasPrefix(p, "/apiv1/deployments/"):
			w.Write(json(`{"id":"d1","name":"frontend","status":"running","buildStatus":"success","replicas":3,"availableReplicas":3,"image":"ghcr.io/hackclub/leaf-frontend:latest","totalCpuUsage":340,"totalMemoryUsage":287309824,"ingresses":[{"host":"orchard.infra.hackclub.com"}],"envVars":[{"key":"NODE_ENV","value":"production"},{"key":"PUBLIC_API_BASE","value":"https://orchard.infra.hackclub.com"},{"key":"LOG_LEVEL","value":"info"}]}`))
		default:
			w.Write(json(`{}`))
		}
	}))
}

func metricsFixture() string {
	cpu := []float64{120, 180, 150, 220, 340, 300, 280, 360, 410, 390, 340, 300, 260, 340}
	mem := []float64{180, 190, 210, 240, 260, 255, 270, 280, 290, 287, 285, 286, 288, 287}
	var b strings.Builder
	b.WriteString(`{"data":{"cpu":[`)
	for i, v := range cpu {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(jsonPoint(i, v))
	}
	b.WriteString(`],"memory":[`)
	for i, v := range mem {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(jsonPoint(i, v*1024*1024))
	}
	b.WriteString(`]}}`)
	return b.String()
}

func jsonPoint(ts int, v float64) string {
	return `{"timestamp":` + strconv.Itoa(ts) + `,"value":` + strconv.FormatFloat(v, 'f', 0, 64) + `}`
}

func demoClient() *api.Client {
	srv := demoServer()
	return api.New(srv.URL, "demo")
}
