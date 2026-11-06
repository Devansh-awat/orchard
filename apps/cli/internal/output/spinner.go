package output

import (
	"fmt"
	"os"
	"sync"
	"time"

	"golang.org/x/term"
)

var spinnerFrames = []string{"⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"}

// StderrIsTTY reports whether stderr is an interactive terminal. Spinners key
// off stderr (not stdout) because status output goes there while stdout stays
// pure data.
func StderrIsTTY() bool {
	return term.IsTerminal(int(os.Stderr.Fd()))
}

// Spinner renders an animated status line with elapsed time on stderr. On a
// non-TTY it degrades to plain Warnf lines per Update, so CI logs and piped
// runs keep the historical one-line-per-transition behavior.
type Spinner struct {
	mu      sync.Mutex
	msg     string
	stopCh  chan struct{}
	doneCh  chan struct{}
	active  bool
	started time.Time
}

func NewSpinner(msg string) *Spinner {
	s := &Spinner{msg: SanitizeStyledLine(msg), started: time.Now()}
	if !StderrIsTTY() {
		return s
	}
	s.active = true
	s.stopCh = make(chan struct{})
	s.doneCh = make(chan struct{})
	go s.loop()
	return s
}

func (s *Spinner) loop() {
	defer close(s.doneCh)
	t := time.NewTicker(90 * time.Millisecond)
	defer t.Stop()
	i := 0
	for {
		select {
		case <-s.stopCh:
			fmt.Fprint(os.Stderr, "\r\x1b[K")
			return
		case <-t.C:
			s.mu.Lock()
			msg := s.msg
			s.mu.Unlock()
			elapsed := time.Since(s.started).Round(time.Second)
			fmt.Fprintf(
				os.Stderr,
				"\r\x1b[K%s %s %s",
				warnStyle.Render(spinnerFrames[i%len(spinnerFrames)]),
				msg,
				dimStyle.Render(elapsed.String()),
			)
			i++
		}
	}
}

func (s *Spinner) Update(msg string) {
	s.mu.Lock()
	s.msg = SanitizeStyledLine(msg)
	active := s.active
	s.mu.Unlock()
	if !active {
		Warnf("%s", msg)
	}
}

// Stop clears the spinner line. Safe to call more than once; callers must stop
// before printing their own terminal-state lines.
func (s *Spinner) Stop() {
	s.mu.Lock()
	if !s.active {
		s.mu.Unlock()
		return
	}
	s.active = false
	s.mu.Unlock()
	close(s.stopCh)
	<-s.doneCh
}
