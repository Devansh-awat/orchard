package api

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/hackclub/orchard/fc-builder/internal/auth"
	"github.com/hackclub/orchard/fc-builder/internal/builds"
	"github.com/hackclub/orchard/fc-builder/internal/proto"
	"github.com/hackclub/orchard/fc-builder/internal/vm"
)

type StatusSource func() proto.HostStatus

type Server struct {
	runner       *builds.Runner
	status       StatusSource
	acquireLimit time.Duration
}

func New(runner *builds.Runner, status StatusSource, acquireLimit time.Duration) *Server {
	return &Server{runner: runner, status: status, acquireLimit: acquireLimit}
}

func (s *Server) Handler(secret []byte) http.Handler {
	api := http.NewServeMux()
	api.HandleFunc("POST /v1/builds", s.create)
	api.HandleFunc("GET /v1/builds/{id}", s.get)
	api.HandleFunc("GET /v1/builds/{id}/events", s.events)
	api.HandleFunc("DELETE /v1/builds/{id}", s.cancel)
	api.HandleFunc("DELETE /v1/builds", s.cancelDeployment)
	api.HandleFunc("GET /v1/status", s.hostStatus)
	root := http.NewServeMux()
	root.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok")) })
	root.Handle("/v1/", auth.Middleware(secret, api))
	return root
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]string{"error": code, "message": msg})
}

func (s *Server) create(w http.ResponseWriter, r *http.Request) {
	var req proto.BuildRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<20)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if err := builds.Validate(req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	b, ok := s.runner.Get(req.ID)
	if !ok {
		ctx, cancel := context.WithTimeout(r.Context(), s.acquireLimit)
		var err error
		b, err = s.runner.Start(ctx, req)
		cancel()
		switch {
		case err == nil:
		case errors.Is(err, builds.ErrExists):
			b, _ = s.runner.Get(req.ID)
		case errors.Is(err, vm.ErrNoCapacity):
			writeError(w, http.StatusTooManyRequests, "no_capacity", err.Error())
			return
		default:
			log.Printf("[fc-builder] build %s could not start: %v", req.ID, err)
			writeError(w, http.StatusServiceUnavailable, "unavailable", err.Error())
			return
		}
	}
	s.stream(w, r, b, 0)
}

func (s *Server) stream(w http.ResponseWriter, r *http.Request, b *builds.Build, offset int64) {
	if b.Log == nil {
		writeError(w, http.StatusConflict, "starting", "build is still starting")
		return
	}
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Build-Status", b.Status().Status)
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)
	flush := func() {
		if flusher != nil {
			flusher.Flush()
		}
	}
	flush()
	b.Log.Follow(r.Context(), offset, w, flush)
}

func (s *Server) get(w http.ResponseWriter, r *http.Request) {
	b, ok := s.runner.Get(r.PathValue("id"))
	if !ok {
		writeError(w, http.StatusNotFound, "not_found", "unknown build")
		return
	}
	writeJSON(w, http.StatusOK, b.Status())
}

func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	b, ok := s.runner.Get(r.PathValue("id"))
	if !ok {
		writeError(w, http.StatusNotFound, "not_found", "unknown build")
		return
	}
	offset, _ := strconv.ParseInt(r.URL.Query().Get("offset"), 10, 64)
	s.stream(w, r, b, offset)
}

func (s *Server) cancel(w http.ResponseWriter, r *http.Request) {
	if err := s.runner.Cancel(r.PathValue("id")); err != nil {
		writeError(w, http.StatusNotFound, "not_found", "unknown build")
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]bool{"cancelled": true})
}

func (s *Server) cancelDeployment(w http.ResponseWriter, r *http.Request) {
	dep := r.URL.Query().Get("deploymentId")
	if dep == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "deploymentId is required")
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"cancelled": s.runner.CancelDeployment(dep)})
}

func (s *Server) hostStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.status())
}
