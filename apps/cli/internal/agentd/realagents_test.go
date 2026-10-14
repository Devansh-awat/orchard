package agentd

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRealAgentsSpeakACPThroughTheDaemon(t *testing.T) {
	wanted := strings.Split(os.Getenv("AGENTD_REAL_AGENTS"), ",")
	if os.Getenv("AGENTD_REAL_AGENTS") == "" {
		t.Skip("set AGENTD_REAL_AGENTS=opencode,claude,fx to run against installed agents")
	}
	home := t.TempDir()
	tokenFile := filepath.Join(t.TempDir(), "token")
	_ = os.WriteFile(tokenFile, []byte("secret-token"), 0o600)
	realHome, _ := os.UserHomeDir()
	agentsFile := filepath.Join(home, "agents.json")
	if extra := os.Getenv("AGENTD_REAL_AGENTS_FILE"); extra != "" {
		agentsFile = extra
	}
	d, err := New(Options{TokenFile: tokenFile, Home: home, AgentsFile: agentsFile})
	if err != nil {
		t.Fatal(err)
	}
	d.env.id = &Identity{Name: d.id.Name, Home: realHome, Shell: d.id.Shell}
	h := &harness{t: t, d: d, home: home, token: "secret-token"}
	h.srv = newTestServer(t, d)
	c := h.dial()
	repo := filepath.Join(home, "app")
	gitRepo(t, repo)
	for _, agent := range wanted {
		agent := strings.TrimSpace(agent)
		t.Run(agent, func(t *testing.T) {
			var st ChatState
			c.must("chat.create", map[string]any{"agent": agent, "cwd": repo, "title": "smoke"}, &st)
			var log struct {
				Events []Event `json:"events"`
			}
			c.must("chat.events", map[string]any{"chatId": st.ID}, &log)
			if st.AgentSessionID == "" {
				t.Fatalf("%s did not start: %s", agent, lastData(log.Events))
			}
			t.Logf("%s session %s, config %d bytes", agent, st.AgentSessionID, len(st.ConfigOptions))
			if os.Getenv("AGENTD_REAL_PROMPT") == "" {
				return
			}
			c.must("chat.subscribe", map[string]any{"chatId": st.ID, "since": 0}, nil)
			promptText := "Reply with the single word: pong. Do not use any tools."
			if custom := os.Getenv("AGENTD_REAL_PROMPT_TEXT"); custom != "" {
				promptText = custom
			}
			c.must("chat.prompt", map[string]any{"chatId": st.ID, "text": promptText}, nil)
			answered := map[string]bool{}
			for i := 0; i < 600; i++ {
				var pending []PendingRequest
				done := false
				c.mu.Lock()
				done = countKind(c.events, st.ID, "turn.end") >= 1
				for _, e := range c.events {
					if e.ChatID == st.ID && e.Kind == "permission.request" {
						var p PendingRequest
						_ = json.Unmarshal(e.Data, &p)
						if !answered[p.RequestID] {
							pending = append(pending, p)
						}
					}
				}
				c.mu.Unlock()
				if done {
					break
				}
				for _, p := range pending {
					var opts []AcpOption
					_ = json.Unmarshal(p.Options, &opts)
					choice := ""
					for _, o := range opts {
						if o.Kind == "allow_once" || (choice == "" && strings.HasPrefix(o.Kind, "allow")) {
							choice = o.OptionID
						}
					}
					t.Logf("approving %s with %s", p.RequestID, choice)
					c.must("chat.permission", map[string]any{"chatId": st.ID, "requestId": p.RequestID, "optionId": choice}, nil)
					answered[p.RequestID] = true
				}
				time.Sleep(200 * time.Millisecond)
			}
			c.waitFor("a real turn", func(ev []Event, _ []rpcMessage) bool { return countKind(ev, st.ID, "turn.end") >= 1 })
			c.must("chat.events", map[string]any{"chatId": st.ID}, &log)
			text := ""
			for _, e := range log.Events {
				if e.Kind == "update" && strings.Contains(string(e.Data), "agent_message_chunk") {
					var u struct {
						Content struct {
							Text string `json:"text"`
						} `json:"content"`
					}
					_ = json.Unmarshal(e.Data, &u)
					text += u.Content.Text
				}
			}
			t.Logf("%s replied %q, last event %s", agent, text, lastData(log.Events))
			if dump := os.Getenv("AGENTD_REAL_DUMP"); dump != "" {
				raw, _ := json.Marshal(log.Events)
				_ = os.WriteFile(filepath.Join(dump, agent+".json"), raw, 0o644)
			}
			if os.Getenv("AGENTD_REAL_PROMPT_TEXT") == "" && !strings.Contains(strings.ToLower(text), "pong") {
				t.Fatalf("%s did not answer: %s", agent, lastData(log.Events))
			}
		})
	}
}

type AcpOption struct {
	OptionID string `json:"optionId"`
	Kind     string `json:"kind"`
}

func lastData(events []Event) string {
	if len(events) == 0 {
		return ""
	}
	e := events[len(events)-1]
	return e.Kind + " " + string(e.Data)
}
