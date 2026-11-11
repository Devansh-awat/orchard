export function gitCloneScript(branch: string): string {
  return `set -e
echo "=== Cloning repository ==="
MASKED_URL="$(printf '%s' "$CLONE_URL" | sed -E 's#://[^@/]+@#://***@#')"
echo "Repository: $MASKED_URL"
echo "Branch: ${branch}"

LFS_READY=0
if (git lfs version >/dev/null 2>&1 || apk add --no-cache git-lfs >/dev/null 2>&1) && git lfs install --skip-repo >/dev/null 2>&1; then
  LFS_READY=1
  echo "git-lfs: enabled"
else
  echo "git-lfs: unavailable, continuing without it"
fi

# GIT_LFS_SKIP_SMUDGE, not a plain clone: 'git lfs install' registers a global
# smudge filter, and once it is registered an LFS object that cannot be fetched
# (no LFS quota left, endpoint unreachable, the token lacks LFS scope) fails the
# checkout outright with "smudge filter lfs failed". That turned enabling LFS
# into a way to break builds that would otherwise have succeeded with pointer
# files. Content is pulled after the clone instead, where failing is survivable.
PLAIN_URL="$(printf '%s' "$CLONE_URL" | sed -E 's#://[^@/]+@#://#')"
AUTH_BASE="$(printf '%s' "$CLONE_URL" | sed -E 's#^([a-z]+://[^/]+/).*#\\1#')"
PLAIN_BASE="$(printf '%s' "$PLAIN_URL" | sed -E 's#^([a-z]+://[^/]+/).*#\\1#')"
CLONE_OUTPUT=$(GIT_TERMINAL_PROMPT=0 GIT_LFS_SKIP_SMUDGE=1 git -c "url.$AUTH_BASE.insteadOf=$PLAIN_BASE" clone --depth 1 --recurse-submodules --shallow-submodules --branch "${branch}" "$PLAIN_URL" /workspace 2>&1) || {
  SANITIZED_OUTPUT=$(echo "$CLONE_OUTPUT" | sed -E 's/(x-access-token:|ghs_|ghp_|ghu_|gho_|ghr_|github_pat_)[^ @]*/***REDACTED***/g')
  echo "$SANITIZED_OUTPUT"
  if echo "$CLONE_OUTPUT" | grep -q "terminal prompts disabled\\|could not read Username\\|Authentication failed\\|403"; then
    echo ""
    echo "========================================="
    echo "ERROR: GitHub authentication failed."
    echo "Your GitHub account is not connected or does not have access to this repository."
    echo "Please connect your GitHub account in User Settings > GitHub."
    echo "========================================="
  fi
  exit 1
}
echo "$CLONE_OUTPUT" | sed -E 's/(x-access-token:|ghs_|ghp_|ghu_|gho_|ghr_|github_pat_)[^ @]*/***REDACTED***/g'

echo "=== Repository cloned successfully ==="

if [ "$LFS_READY" = "1" ] && [ -n "$(git -C /workspace lfs ls-files 2>/dev/null)" ]; then
  if GIT_TERMINAL_PROMPT=0 git -c "url.$AUTH_BASE.insteadOf=$PLAIN_BASE" -C /workspace lfs pull >/dev/null 2>&1; then
    echo "git-lfs: LFS content fetched"
  else
    echo "git-lfs: could not fetch LFS content, those files stay as pointers"
  fi
fi
echo "Checked out commit: $(git -C /workspace rev-parse HEAD 2>/dev/null || echo unknown)"
ls -la /workspace
`;
}
