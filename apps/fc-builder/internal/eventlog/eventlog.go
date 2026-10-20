package eventlog

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"sync"

	"github.com/hackclub/orchard/fc-builder/internal/proto"
)

var ErrClosed = errors.New("event log closed")

type Log struct {
	path   string
	mu     sync.Mutex
	cond   *sync.Cond
	file   *os.File
	size   int64
	closed bool
}

func Create(path string) (*Log, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return nil, err
	}
	l := &Log{path: path, file: f}
	l.cond = sync.NewCond(&l.mu)
	return l, nil
}

func OpenClosed(path string) (*Log, error) {
	st, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	l := &Log{path: path, size: st.Size(), closed: true}
	l.cond = sync.NewCond(&l.mu)
	return l, nil
}

func (l *Log) Append(ev proto.Event) error {
	line, err := json.Marshal(ev)
	if err != nil {
		return err
	}
	line = append(line, '\n')
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return ErrClosed
	}
	n, err := l.file.Write(line)
	l.size += int64(n)
	l.cond.Broadcast()
	return err
}

func (l *Log) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return nil
	}
	l.closed = true
	l.cond.Broadcast()
	if l.file != nil {
		return l.file.Close()
	}
	return nil
}

func (l *Log) Size() int64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.size
}

func (l *Log) Closed() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.closed
}

func (l *Log) Follow(ctx context.Context, offset int64, w io.Writer, flush func()) error {
	if offset < 0 {
		offset = 0
	}
	stop := context.AfterFunc(ctx, func() {
		l.mu.Lock()
		l.cond.Broadcast()
		l.mu.Unlock()
	})
	defer stop()
	f, err := os.Open(l.path)
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return err
	}
	pos := offset
	for {
		l.mu.Lock()
		for pos >= l.size && !l.closed && ctx.Err() == nil {
			l.cond.Wait()
		}
		size, closed := l.size, l.closed
		l.mu.Unlock()
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if pos < size {
			n, err := io.CopyN(w, f, size-pos)
			pos += n
			if flush != nil {
				flush()
			}
			if err != nil {
				return err
			}
			continue
		}
		if closed {
			return nil
		}
	}
}

func LastResult(path string) (*proto.Event, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var last *proto.Event
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64*1024), 64*1024*1024)
	for sc.Scan() {
		var ev proto.Event
		if json.Unmarshal(sc.Bytes(), &ev) == nil && ev.Type == proto.EventResult {
			e := ev
			last = &e
		}
	}
	return last, sc.Err()
}
