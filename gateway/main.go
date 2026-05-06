// Dev-only reverse proxy. Replaces the docker nginx container that used to
// front-end /apiv1 → backend, everything else → frontend on the same origin.
//
// Usage:
//   go run .                 # listens on :4000, proxies localhost:3000/3001
//   GATEWAY_LISTEN=:80 go run .
//   go run . --listen :9000 --backend http://localhost:4000
package main

import (
	"flag"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
)

func main() {
	listen := flagOrEnv("listen", "GATEWAY_LISTEN", ":4000")
	frontend := flagOrEnv("frontend", "GATEWAY_FRONTEND", "http://localhost:3000")
	backend := flagOrEnv("backend", "GATEWAY_BACKEND", "http://localhost:3001")
	flag.Parse()

	frontendURL := mustParse(*frontend)
	backendURL := mustParse(*backend)

	feProxy := newProxy(frontendURL)
	beProxy := newProxy(backendURL)

	mux := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/apiv1") {
			beProxy.ServeHTTP(w, r)
			return
		}
		feProxy.ServeHTTP(w, r)
	})

	log.Printf("[gateway] listening on %s", *listen)
	log.Printf("[gateway]   /apiv1/* → %s", backendURL)
	log.Printf("[gateway]   else     → %s", frontendURL)
	if err := http.ListenAndServe(*listen, mux); err != nil {
		log.Fatal(err)
	}
}

func newProxy(target *url.URL) *httputil.ReverseProxy {
	p := httputil.NewSingleHostReverseProxy(target)
	// FlushInterval = -1 forces immediate flush after every Write so SSE
	// streams (e.g. /apiv1/events/orgs/:id) reach the browser without buffering.
	// httputil.ReverseProxy detects "Content-Type: text/event-stream" and
	// already flushes after every event with FlushInterval=-1; this also
	// handles HTTP/1.1 chunked streaming responses generally.
	p.FlushInterval = -1
	p.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		log.Printf("[gateway] proxy error %s %s: %v", r.Method, r.URL.Path, err)
		http.Error(w, "Bad gateway", http.StatusBadGateway)
	}
	return p
}

// flagOrEnv registers a string flag whose default comes from $env (or the
// hard-coded default if the env var is unset). Either source can be overridden
// by passing the flag on the command line.
func flagOrEnv(name, env, def string) *string {
	d := os.Getenv(env)
	if d == "" {
		d = def
	}
	return flag.String(name, d, "")
}

func mustParse(s string) *url.URL {
	u, err := url.Parse(s)
	if err != nil {
		log.Fatalf("invalid URL %q: %v", s, err)
	}
	return u
}
