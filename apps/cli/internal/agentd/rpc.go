//go:build !windows

package agentd

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"
)

type rpcMessage struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *RPCError       `json:"error,omitempty"`
}

type RPCError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func (e *RPCError) Error() string {
	return fmt.Sprintf("rpc error %d: %s", e.Code, e.Message)
}

const (
	codeParse          = -32700
	codeInvalidRequest = -32600
	codeMethodNotFound = -32601
	codeInvalidParams  = -32602
	codeInternal       = -32603
	codeNotFound       = -32004
	codeConflict       = -32009
	codeUnavailable    = -32010
)

func rpcErr(code int, format string, args ...any) *RPCError {
	return &RPCError{Code: code, Message: fmt.Sprintf(format, args...)}
}

func asRPCError(err error) *RPCError {
	var re *RPCError
	if errors.As(err, &re) {
		return re
	}
	return &RPCError{Code: codeInternal, Message: err.Error()}
}

type Handler func(ctx context.Context, params json.RawMessage) (any, error)

type InboundHandler func(ctx context.Context, method string, params json.RawMessage) (any, error)

type peer struct {
	send     func(msg []byte) error
	nextID   atomic.Int64
	mu       sync.Mutex
	pending  map[string]chan rpcMessage
	closed   chan struct{}
	closeErr error
	once     sync.Once
}

func newPeer(send func([]byte) error) *peer {
	return &peer{send: send, pending: map[string]chan rpcMessage{}, closed: make(chan struct{})}
}

func (p *peer) close(err error) {
	p.once.Do(func() {
		p.mu.Lock()
		p.closeErr = err
		for id, ch := range p.pending {
			close(ch)
			delete(p.pending, id)
		}
		p.mu.Unlock()
		close(p.closed)
	})
}

func (p *peer) write(msg rpcMessage) error {
	msg.JSONRPC = "2.0"
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	return p.send(data)
}

func (p *peer) notify(method string, params any) error {
	raw, err := json.Marshal(params)
	if err != nil {
		return err
	}
	return p.write(rpcMessage{Method: method, Params: raw})
}

func (p *peer) call(ctx context.Context, method string, params any, out any) error {
	return p.callThen(ctx, method, params, out, nil)
}

func (p *peer) callThen(ctx context.Context, method string, params any, out any, sent func()) error {
	raw, err := json.Marshal(params)
	if err != nil {
		return err
	}
	id := p.nextID.Add(1)
	key := fmt.Sprint(id)
	ch := make(chan rpcMessage, 1)
	p.mu.Lock()
	select {
	case <-p.closed:
		p.mu.Unlock()
		return p.deadErr()
	default:
	}
	p.pending[key] = ch
	p.mu.Unlock()
	idRaw, _ := json.Marshal(id)
	if err := p.write(rpcMessage{ID: idRaw, Method: method, Params: raw}); err != nil {
		p.mu.Lock()
		delete(p.pending, key)
		p.mu.Unlock()
		return err
	}
	if sent != nil {
		sent()
	}
	select {
	case msg, ok := <-ch:
		if !ok {
			return p.deadErr()
		}
		if msg.Error != nil {
			return msg.Error
		}
		if out != nil && len(msg.Result) > 0 {
			return json.Unmarshal(msg.Result, out)
		}
		return nil
	case <-ctx.Done():
		p.mu.Lock()
		delete(p.pending, key)
		p.mu.Unlock()
		return ctx.Err()
	}
}

func (p *peer) deadErr() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closeErr != nil {
		return fmt.Errorf("connection closed: %w", p.closeErr)
	}
	return errors.New("connection closed")
}

func (p *peer) dispatch(ctx context.Context, data []byte, inbound InboundHandler) {
	var msg rpcMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		_ = p.write(rpcMessage{ID: json.RawMessage("null"), Error: rpcErr(codeParse, "invalid json")})
		return
	}
	if msg.Method == "" {
		if len(msg.ID) == 0 {
			return
		}
		key := string(msg.ID)
		var n int64
		if json.Unmarshal(msg.ID, &n) == nil {
			key = fmt.Sprint(n)
		}
		p.mu.Lock()
		ch := p.pending[key]
		delete(p.pending, key)
		p.mu.Unlock()
		if ch != nil {
			ch <- msg
		}
		return
	}
	if inbound == nil {
		if len(msg.ID) > 0 {
			_ = p.write(rpcMessage{ID: msg.ID, Error: rpcErr(codeMethodNotFound, "method %s not found", msg.Method)})
		}
		return
	}
	run := func() {
		result, err := inbound(ctx, msg.Method, msg.Params)
		if len(msg.ID) == 0 {
			return
		}
		if err != nil {
			_ = p.write(rpcMessage{ID: msg.ID, Error: asRPCError(err)})
			return
		}
		raw, merr := json.Marshal(result)
		if merr != nil {
			_ = p.write(rpcMessage{ID: msg.ID, Error: asRPCError(merr)})
			return
		}
		_ = p.write(rpcMessage{ID: msg.ID, Result: raw})
	}
	go run()
}

func decode[T any](raw json.RawMessage) (T, error) {
	var v T
	if len(raw) == 0 {
		return v, nil
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		return v, rpcErr(codeInvalidParams, "invalid params: %v", err)
	}
	return v, nil
}

func withTimeout(ctx context.Context, ms int, def time.Duration) (context.Context, context.CancelFunc) {
	d := def
	if ms > 0 {
		d = time.Duration(ms) * time.Millisecond
	}
	return context.WithTimeout(ctx, d)
}
