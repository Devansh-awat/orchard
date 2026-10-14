package agentd

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	if os.Getenv("AGENTD_FAKE_AGENT") == "1" {
		runFakeAgent()
		os.Exit(0)
	}
	os.Exit(m.Run())
}

type fakeAgent struct {
	out      *bufio.Writer
	mu       sync.Mutex
	nextID   atomic.Int64
	waiting  map[string]chan json.RawMessage
	sessions map[string]string
	cancel   map[string]chan struct{}
	history  map[string][]string
}

func (f *fakeAgent) send(v any) {
	raw, _ := json.Marshal(v)
	f.mu.Lock()
	defer f.mu.Unlock()
	f.out.Write(raw)
	f.out.WriteByte('\n')
	f.out.Flush()
}

func (f *fakeAgent) update(session string, update map[string]any) {
	f.send(map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": map[string]any{"sessionId": session, "update": update}})
}

func (f *fakeAgent) request(method string, params any) json.RawMessage {
	id := fmt.Sprint(f.nextID.Add(1) + 1000)
	ch := make(chan json.RawMessage, 1)
	f.mu.Lock()
	f.waiting[id] = ch
	f.mu.Unlock()
	f.send(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params})
	return <-ch
}

func runFakeAgent() {
	if os.Getenv("FAKE_AGENT_FAIL_INIT") != "" {
		in := bufio.NewScanner(os.Stdin)
		for in.Scan() {
			var msg struct {
				ID json.RawMessage `json:"id"`
			}
			_ = json.Unmarshal(in.Bytes(), &msg)
			raw, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": msg.ID, "error": map[string]any{"code": -32600, "message": os.Getenv("FAKE_AGENT_FAIL_INIT")}})
			os.Stdout.Write(append(raw, '\n'))
		}
		return
	}
	f := &fakeAgent{out: bufio.NewWriter(os.Stdout), waiting: map[string]chan json.RawMessage{}, sessions: map[string]string{}, cancel: map[string]chan struct{}{}, history: map[string][]string{}}
	in := bufio.NewScanner(os.Stdin)
	in.Buffer(make([]byte, 1<<20), 16<<20)
	for in.Scan() {
		var msg struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
			Result json.RawMessage `json:"result"`
		}
		if json.Unmarshal(in.Bytes(), &msg) != nil {
			continue
		}
		if msg.Method == "" {
			var id string
			_ = json.Unmarshal(msg.ID, &id)
			f.mu.Lock()
			ch := f.waiting[id]
			delete(f.waiting, id)
			f.mu.Unlock()
			if ch != nil {
				ch <- msg.Result
			}
			continue
		}
		reply := func(result any) {
			f.send(map[string]any{"jsonrpc": "2.0", "id": msg.ID, "result": result})
		}
		var p map[string]any
		_ = json.Unmarshal(msg.Params, &p)
		session, _ := p["sessionId"].(string)
		switch msg.Method {
		case "initialize":
			reply(map[string]any{"protocolVersion": 1, "agentCapabilities": map[string]any{"loadSession": true, "sessionCapabilities": map[string]any{"close": map[string]any{}}}, "agentInfo": map[string]string{"name": "fake", "version": "9.9"}})
		case "session/new":
			id := fmt.Sprintf("fake_%d_%d", os.Getpid(), time.Now().UnixNano())
			f.sessions[id] = p["cwd"].(string)
			reply(map[string]any{"sessionId": id, "configOptions": []map[string]any{{"id": "model", "name": "Model", "category": "model", "type": "select", "currentValue": "small", "options": []map[string]string{{"value": "small", "name": "Small"}, {"value": "big", "name": "Big"}}}}})
		case "session/load":
			cwd, _ := p["cwd"].(string)
			f.sessions[session] = cwd
			for _, line := range loadHistory(cwd, session) {
				f.update(session, map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]string{"type": "text", "text": "replayed " + line}})
			}
			reply(map[string]any{})
		case "session/close":
			reply(map[string]any{})
		case "session/set_config_option":
			reply(map[string]any{"configOptions": []map[string]any{{"id": "model", "name": "Model", "type": "select", "currentValue": p["value"]}}})
		case "session/cancel":
			f.mu.Lock()
			if ch := f.cancel[session]; ch != nil {
				close(ch)
				delete(f.cancel, session)
			}
			f.mu.Unlock()
		case "session/prompt":
			go f.prompt(msg.ID, session, p)
		default:
			f.send(map[string]any{"jsonrpc": "2.0", "id": msg.ID, "error": map[string]any{"code": -32601, "message": "nope"}})
		}
	}
}

func historyFile(cwd, session string) string {
	return filepath.Join(cwd, ".fake-history-"+session)
}

func loadHistory(cwd, session string) []string {
	raw, err := os.ReadFile(historyFile(cwd, session))
	if err != nil {
		return nil
	}
	return strings.Split(strings.TrimSpace(string(raw)), "\n")
}

func (f *fakeAgent) prompt(id json.RawMessage, session string, p map[string]any) {
	text := ""
	if blocks, ok := p["prompt"].([]any); ok && len(blocks) > 0 {
		if b, ok := blocks[0].(map[string]any); ok {
			text, _ = b["text"].(string)
		}
	}
	cwd := f.sessions[session]
	reply := func(stop string) {
		f.send(map[string]any{"jsonrpc": "2.0", "id": id, "result": map[string]string{"stopReason": stop}})
	}
	if hist, err := os.OpenFile(historyFile(cwd, session), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600); err == nil {
		fmt.Fprintln(hist, text)
		hist.Close()
	}
	if text == "crash" {
		os.Exit(3)
	}
	f.update(session, map[string]any{"sessionUpdate": "agent_message_chunk", "messageId": "m1", "content": map[string]string{"type": "text", "text": "on it: " + text}})
	if strings.HasPrefix(text, "edit ") {
		name := strings.TrimPrefix(text, "edit ")
		f.update(session, map[string]any{"sessionUpdate": "tool_call", "toolCallId": "t1", "title": "Edit " + name, "kind": "edit", "status": "pending", "rawInput": map[string]string{"path": name}})
		_ = os.WriteFile(filepath.Join(cwd, name), []byte("edited by the agent\n"), 0o644)
		f.update(session, map[string]any{"sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "completed"})
	}
	if text == "perm" {
		f.update(session, map[string]any{"sessionUpdate": "tool_call", "toolCallId": "t2", "title": "Run rm", "kind": "execute", "status": "pending"})
		res := f.request("session/request_permission", map[string]any{"sessionId": session, "toolCall": map[string]string{"toolCallId": "t2"}, "options": []map[string]string{{"optionId": "allow", "name": "Allow", "kind": "allow_once"}, {"optionId": "deny", "name": "Deny", "kind": "reject_once"}}})
		var out struct {
			Outcome struct {
				Outcome  string `json:"outcome"`
				OptionID string `json:"optionId"`
			} `json:"outcome"`
		}
		_ = json.Unmarshal(res, &out)
		status := "failed"
		if out.Outcome.OptionID == "allow" {
			status = "completed"
		}
		f.update(session, map[string]any{"sessionUpdate": "tool_call_update", "toolCallId": "t2", "status": status})
	}
	if text == "slow" {
		ch := make(chan struct{})
		f.mu.Lock()
		f.cancel[session] = ch
		f.mu.Unlock()
		select {
		case <-ch:
			reply("cancelled")
			return
		case <-time.After(10 * time.Second):
		}
	}
	if text == "big" {
		f.update(session, map[string]any{"sessionUpdate": "tool_call_update", "toolCallId": "t3", "rawOutput": strings.Repeat("x", 200<<10)})
	}
	reply("end_turn")
}
