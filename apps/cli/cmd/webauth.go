package cmd

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/hackclub/orchard/cli/internal/api"
	"github.com/hackclub/orchard/cli/internal/config"
	"github.com/hackclub/orchard/cli/internal/output"
)

// webLogin runs the browser/loopback login: it opens the Orchard web app, which
// (using the user's existing session) mints an orch_ API token and redirects it
// back to a localhost callback this process is listening on. No MCP token is
// involved: the minted orch_ token is a first-class credential the /apiv1 guard
// accepts directly.
func webLogin(cfg *config.Config, webBase string, openBrowserFlag bool) error {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return fmt.Errorf("could not start local callback server: %w", err)
	}
	defer ln.Close()
	port := ln.Addr().(*net.TCPAddr).Port

	state, err := randomState()
	if err != nil {
		return err
	}

	label := "Orchard CLI"
	if host, herr := os.Hostname(); herr == nil && host != "" {
		label = "Orchard CLI (" + host + ")"
	}

	authURL := strings.TrimRight(webBase, "/") + "/cli/auth?" + url.Values{
		"port":  {fmt.Sprintf("%d", port)},
		"state": {state},
		"label": {label},
	}.Encode()

	type result struct {
		token string
		err   error
	}
	resCh := make(chan result, 1)

	// Send the browser back into the real app for the final screen so it matches
	// the rest of the UI, instead of rendering a standalone lookalike here.
	done := strings.TrimRight(webBase, "/") + "/cli/done"
	finish := func(w http.ResponseWriter, r *http.Request, errCode string) {
		dest := done
		if errCode != "" {
			dest += "?error=" + url.QueryEscape(errCode)
		}
		http.Redirect(w, r, dest, http.StatusFound)
	}

	srv := &http.Server{}
	mux := http.NewServeMux()
	deliver := func(res result) {
		select {
		case resCh <- res:
		default:
		}
	}
	mux.HandleFunc("/callback", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions {
			h := w.Header()
			h.Set("Access-Control-Allow-Origin", "*")
			h.Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
			h.Set("Access-Control-Allow-Headers", "Content-Type")
			h.Set("Access-Control-Allow-Private-Network", "true")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if err := r.ParseForm(); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		q := r.Form
		if got := q.Get("state"); got != state {
			http.Error(w, "state mismatch", http.StatusBadRequest)
			return
		}
		if e := q.Get("error"); e != "" {
			finish(w, r, e)
			deliver(result{err: fmt.Errorf("authorization failed: %s", e)})
			return
		}
		token := q.Get("token")
		if token == "" {
			finish(w, r, "no_token")
			deliver(result{err: errors.New("no token in callback")})
			return
		}
		finish(w, r, "")
		deliver(result{token: token})
	})
	srv.Handler = mux

	go func() {
		if serr := srv.Serve(ln); serr != nil && serr != http.ErrServerClosed {
			resCh <- result{err: serr}
		}
	}()

	if openBrowserFlag {
		fmt.Fprintln(os.Stderr, output.Dim("opening browser to authorize…"))
		fmt.Fprintln(os.Stderr, output.Dim("if it doesn't open, visit:\n  ")+authURL)
		_ = api.OpenBrowser(authURL)
	} else {
		printManualAuth(os.Stderr, authURL, port)
	}

	select {
	case res := <-resCh:
		_ = srv.Shutdown(context.Background())
		if res.err != nil {
			return res.err
		}
		cfg.Token = res.token
	case <-time.After(5 * time.Minute):
		_ = srv.Shutdown(context.Background())
		return errors.New("timed out waiting for browser authorization")
	}

	cl := api.New(cfg.APIURL, cfg.Token)
	var me map[string]any
	if err := cl.GetJSON(context.Background(), "/auth/me", &me); err != nil {
		return fmt.Errorf("token verification failed: %w", err)
	}
	if err := cfg.Save(); err != nil {
		return err
	}
	output.Successf("logged in to %s as %s", cfg.APIURL, displayUser(me))
	return nil
}

func printManualAuth(w io.Writer, authURL string, port int) {
	fmt.Fprintln(w, output.Dim("open this in a browser to authorize:\n  ")+authURL)
	fmt.Fprintln(w, output.Dim(fmt.Sprintf(
		"it calls back to localhost:%d on the machine with the browser. On a remote box, tunnel it first:\n  ssh -L %d:127.0.0.1:%d <this-host>",
		port, port, port,
	)))
}

func randomState() (string, error) {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
