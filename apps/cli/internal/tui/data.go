package tui

import (
	"bytes"
	"context"
	"strconv"

	"github.com/LeafdTK/leaf/cli/internal/api"
)

// flexNum decodes a JSON number OR a numeric string. The API serializes Prisma
// BigInt columns (e.g. memoryRequestBytes) as quoted strings, which would
// otherwise break decoding of the entire response.
type flexNum float64

func (n *flexNum) UnmarshalJSON(b []byte) error {
	b = bytes.Trim(b, `"`)
	if len(b) == 0 || string(b) == "null" {
		return nil
	}
	f, err := strconv.ParseFloat(string(b), 64)
	if err != nil {
		return nil // tolerate anything unexpected rather than failing the list
	}
	*n = flexNum(f)
	return nil
}

type Org struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Slug string `json:"slug"`
}

type Project struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	Slug           string `json:"slug"`
	Description    string `json:"description"`
	OrganizationID string `json:"organizationId"`
	Count          struct {
		Deployments int `json:"deployments"`
		Databases   int `json:"databases"`
	} `json:"_count"`
	Organization Org `json:"organization"`
}

type EnvVar struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

type Deployment struct {
	ID                string   `json:"id"`
	Name              string   `json:"name"`
	Namespace         string   `json:"namespace"`
	Image             string   `json:"image"`
	Replicas          int      `json:"replicas"`
	AvailableReplicas int      `json:"availableReplicas"`
	Status            string   `json:"status"`
	BuildStatus       string   `json:"buildStatus"`
	BuildStep         string   `json:"buildStep"`
	GithubRepo        string   `json:"githubRepo"`
	GithubBranch      string   `json:"githubBranch"`
	TotalCPUUsage     flexNum  `json:"totalCpuUsage"`
	TotalMemoryUsage  flexNum  `json:"totalMemoryUsage"`
	CPURequestMilli   flexNum  `json:"cpuRequestMilli"`
	MemoryRequestB    flexNum  `json:"memoryRequestBytes"`
	EnvVars           []EnvVar `json:"envVars"`
	Ingresses         []struct {
		Host string `json:"host"`
	} `json:"ingresses"`
}

type Pod struct {
	Name         string `json:"name"`
	Namespace    string `json:"namespace"`
	Status       string `json:"status"`
	RestartCount int    `json:"restartCount"`
	NodeName     string `json:"nodeName"`
	Ready        string `json:"ready"`
	Age          string `json:"age"`
	CreatedAt    string `json:"createdAt"`
}

type Database struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Status string `json:"status"`
	Mode   string `json:"mode"`
}

type MetricPoint struct {
	Timestamp float64 `json:"timestamp"`
	Value     float64 `json:"value"`
}

type MetricsResp struct {
	Data struct {
		CPU    []MetricPoint `json:"cpu"`
		Memory []MetricPoint `json:"memory"`
	} `json:"data"`
}

type logsResp struct {
	Logs       string `json:"logs"`
	Status     string `json:"status"`
	BuildError string `json:"buildError"`
}

// helpers shared by commands
func getList[T any](cl *api.Client, path string) ([]T, error) {
	var out []T
	if err := cl.GetJSON(context.Background(), path, &out); err != nil {
		return nil, err
	}
	return out, nil
}
