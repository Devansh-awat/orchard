package proto

import (
	"encoding/json"
	"time"
)

const (
	GuestPort = 1024

	SourceGit     = "git"
	SourceContext = "context"

	EventAccepted = "accepted"
	EventPhase    = "phase"
	EventLog      = "log"
	EventResult   = "result"

	PhaseVM     = "vm"
	PhaseReady  = "ready"
	PhaseSource = "source"

	StatusRunning   = "running"
	StatusSucceeded = "succeeded"
	StatusFailed    = "failed"
	StatusLost      = "lost"

	OpBuild = "build"
	OpPing  = "ping"
)

type Source struct {
	Kind       string `json:"kind"`
	CloneURL   string `json:"cloneUrl,omitempty"`
	Branch     string `json:"branch,omitempty"`
	ContextURL string `json:"contextUrl,omitempty"`
}

type Step struct {
	Name   string            `json:"name"`
	Script string            `json:"script"`
	Env    map[string]string `json:"env,omitempty"`
}

type BuildRequest struct {
	ID             string          `json:"id"`
	DeploymentID   string          `json:"deploymentId"`
	Tenant         string          `json:"tenant"`
	Repository     string          `json:"repository"`
	Source         Source          `json:"source"`
	Steps          []Step          `json:"steps"`
	DockerConfig   json.RawMessage `json:"dockerConfig,omitempty"`
	TimeoutSeconds int             `json:"timeoutSeconds,omitempty"`
}

type GuestRequest struct {
	Op    string        `json:"op"`
	Build *BuildRequest `json:"build,omitempty"`
}

type Event struct {
	Type    string           `json:"t"`
	At      int64            `json:"at"`
	Phase   string           `json:"phase,omitempty"`
	Stream  string           `json:"stream,omitempty"`
	Data    string           `json:"data,omitempty"`
	OK      bool             `json:"ok,omitempty"`
	Error   string           `json:"error,omitempty"`
	Timings map[string]int64 `json:"timings,omitempty"`
}

type BuildStatus struct {
	ID           string `json:"id"`
	DeploymentID string `json:"deploymentId"`
	Tenant       string `json:"tenant"`
	Status       string `json:"status"`
	Error        string `json:"error,omitempty"`
	StartedAt    int64  `json:"startedAt"`
	FinishedAt   int64  `json:"finishedAt,omitempty"`
}

type VMStatus struct {
	Tenant string `json:"tenant"`
	Slot   int    `json:"slot"`
	State  string `json:"state"`
	Active int    `json:"active"`
}

type HostStatus struct {
	HostID       string     `json:"hostId"`
	Version      string     `json:"version"`
	MaxVMs       int        `json:"maxVms"`
	VMs          []VMStatus `json:"vms"`
	ActiveBuilds int        `json:"activeBuilds"`
	CacheTenants []string   `json:"cacheTenants"`
	DiskTotal    uint64     `json:"diskTotal"`
	DiskUsed     uint64     `json:"diskUsed"`
}

func Now() int64 {
	return time.Now().UnixMilli()
}

func Log(stream, data string) Event {
	return Event{Type: EventLog, At: Now(), Stream: stream, Data: data}
}

func Phase(phase string) Event {
	return Event{Type: EventPhase, At: Now(), Phase: phase}
}

func Result(err error, timings map[string]int64) Event {
	ev := Event{Type: EventResult, At: Now(), OK: err == nil, Timings: timings}
	if err != nil {
		ev.Error = err.Error()
	}
	return ev
}
