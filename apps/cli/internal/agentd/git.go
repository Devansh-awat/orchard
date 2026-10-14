//go:build !windows

package agentd

import (
	"context"
	"fmt"
	"regexp"
	"strings"
)

var commitRE = regexp.MustCompile(`^[0-9a-f]{40}([0-9a-f]{24})?$`)

func shq(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

const gitIdentityEnv = `export GIT_AUTHOR_NAME=Orchard GIT_AUTHOR_EMAIL=agent@orchard.local GIT_COMMITTER_NAME=Orchard GIT_COMMITTER_EMAIL=agent@orchard.local`

func checkpointScript(chatID string, seq int64) string {
	return strings.Join([]string{
		`git rev-parse --git-dir >/dev/null 2>&1 || exit 0`,
		gitIdentityEnv,
		`idx=$(mktemp) || exit 1`,
		`trap 'rm -f "$idx"' EXIT`,
		`cur=$(git rev-parse --git-path index)`,
		`[ -f "$cur" ] && cp "$cur" "$idx"`,
		`GIT_INDEX_FILE="$idx" git add -A >/dev/null 2>&1 || exit 1`,
		`tree=$(GIT_INDEX_FILE="$idx" git write-tree) || exit 1`,
		`if git rev-parse -q --verify HEAD >/dev/null; then commit=$(printf 'orchard checkpoint\n' | git commit-tree "$tree" -p HEAD); else commit=$(printf 'orchard checkpoint\n' | git commit-tree "$tree"); fi || exit 1`,
		fmt.Sprintf(`git update-ref %s "$commit" || exit 1`, shq(fmt.Sprintf("refs/orchard/checkpoints/%s/%d", chatID, seq))),
		`printf '%s\n' "$commit"`,
	}, "\n")
}

func revertScript(commit string) string {
	return strings.Join([]string{
		`git rev-parse --git-dir >/dev/null 2>&1 || exit 3`,
		fmt.Sprintf(`git cat-file -e %s 2>/dev/null || exit 4`, shq(commit+"^{tree}")),
		`git add -A >/dev/null 2>&1 || exit 5`,
		fmt.Sprintf(`git read-tree -u --reset %s || exit 5`, shq(commit+"^{tree}")),
		`git reset -q >/dev/null 2>&1 || true`,
	}, "\n")
}

func deleteCheckpointsScript(chatID string) string {
	prefix := fmt.Sprintf("refs/orchard/checkpoints/%s/", chatID)
	return fmt.Sprintf(`git rev-parse --git-dir >/dev/null 2>&1 || exit 0
git for-each-ref --format='delete %%(refname)' %s | git update-ref --stdin >/dev/null 2>&1 || true`, shq(prefix))
}

func (d *Daemon) checkpoint(ctx context.Context, cwd, chatID string, seq int64) string {
	if !chatIDRE.MatchString(chatID) {
		return ""
	}
	res, err := d.runScript(ctx, execParams{Script: checkpointScript(chatID, seq), Cwd: cwd, TimeoutMs: 10000})
	if err != nil || !res.OK {
		return ""
	}
	out := strings.TrimSpace(res.Stdout)
	if !commitRE.MatchString(out) {
		return ""
	}
	return out
}

func (d *Daemon) revert(ctx context.Context, chatID, commit string, author *Author) (any, error) {
	if !commitRE.MatchString(commit) {
		return nil, rpcErr(codeInvalidParams, "invalid checkpoint")
	}
	c, err := d.chatByID(chatID)
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	busy := c.outstanding > 0 || c.starting != nil
	cwd := c.meta.Cwd
	c.mu.Unlock()
	if busy {
		return nil, rpcErr(codeConflict, "stop the agent before reverting")
	}
	res, err := d.runScript(ctx, execParams{Script: revertScript(commit), Cwd: cwd, TimeoutMs: 60000})
	if err != nil {
		return nil, err
	}
	switch {
	case res.ExitCode != nil && *res.ExitCode == 4:
		return nil, rpcErr(codeNotFound, "that checkpoint no longer exists")
	case !res.OK:
		return nil, rpcErr(codeInternal, "revert failed: %s", strings.TrimSpace(res.Stderr))
	}
	c.mu.Lock()
	c.appendLocked("revert", author, map[string]string{"commit": commit})
	c.mu.Unlock()
	return map[string]bool{"ok": true}, nil
}
