package main

import (
	"bufio"
	"context"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

var noreplyRe = regexp.MustCompile(`^(?:\d+\+)?([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)@users\.noreply\.github\.com$`)

type addedInfo struct {
	person person
	at     string
}

func loadAuthors(file string) (map[string]string, error) {
	out := map[string]string{}
	if file == "" {
		return out, nil
	}
	f, err := os.Open(file)
	if err != nil {
		if os.IsNotExist(err) {
			return out, nil
		}
		return nil, err
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) == 2 {
			out[strings.ToLower(fields[0])] = fields[1]
		}
	}
	return out, scanner.Err()
}

func loginFor(email string, authors map[string]string) string {
	email = strings.ToLower(strings.TrimSpace(email))
	if login, ok := authors[email]; ok {
		return login
	}
	if m := noreplyRe.FindStringSubmatch(email); m != nil {
		return m[1]
	}
	return ""
}

func (p *publisher) addedBy(file string) *addedInfo {
	if !p.git {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", "log", "--diff-filter=A", "--follow", "--format=%aN%x00%aE%x00%aI", "--", file)
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	first := strings.TrimSpace(lines[len(lines)-1])
	parts := strings.Split(first, "\x00")
	if len(parts) != 3 || parts[0] == "" {
		return nil
	}
	return &addedInfo{person: person{Name: parts[0], Login: loginFor(parts[1], p.authors)}, at: parts[2]}
}
