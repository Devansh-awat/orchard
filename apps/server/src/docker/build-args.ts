/**
 * Orchard hands every deployment env var to the builder as a `--build-arg`, but
 * a Dockerfile only sees a build arg it declares with `ARG`. Asking users to
 * write `ARG DATABASE_URL` for each of their variables isn't reasonable, so the
 * build job rewrites the Dockerfile and declares them.
 *
 * It declares `ARG` and nothing else. `ARG X` already exposes X as an
 * environment variable to `RUN` inside the stage that declares it, which is the
 * entire reason this injection exists. The `ENV X=${X}` that used to be emitted
 * alongside it bought nothing at build time and wrote every value — API keys
 * included — into the image config, where anyone who can pull the image reads
 * it straight back out of `docker inspect`. It also meant a variable deleted
 * from the config kept shipping inside the image until the next rebuild.
 */

/** `ARG` declarations for a set of env keys, one per line. */
export function buildArgDeclarations(keys: string[]): string {
  return keys.map((key) => `ARG ${key}`).join('\n');
}

/**
 * The init-container script that inserts those declarations into the user's
 * Dockerfile. Reads `$WORKSPACE` so it can be exercised outside the cluster;
 * the build job leaves it unset and gets /workspace.
 */
export function injectBuildArgsScript(opts: { dockerfilePath: string; keys: string[] }): string {
  return `set -ex
echo "=== Injecting ARG declarations into Dockerfile ==="

WORKSPACE="\${WORKSPACE:-/workspace}"
DOCKERFILE_PATH="${opts.dockerfilePath}"
DOCKERFILE="\${WORKSPACE}/\${DOCKERFILE_PATH}"

if [ ! -f "\${DOCKERFILE}" ]; then
  echo "Error: Dockerfile not found at \${DOCKERFILE}"
  ls -la "\${WORKSPACE}"
  exit 1
fi

ARGS_FILE="$(mktemp)"
cat > "\${ARGS_FILE}" << 'EOF'
# Auto-injected build arguments
${buildArgDeclarations(opts.keys)}

EOF

# Declare inside the stage rather than above it: an ARG before the first FROM
# is global scope and only usable by FROM lines themselves.
awk -v argsfile="\${ARGS_FILE}" '
  { print }
  /^FROM / && !done {
    while ((getline line < argsfile) > 0) print line
    close(argsfile)
    done = 1
  }
' "\${DOCKERFILE}" > "\${ARGS_FILE}.out" && mv "\${ARGS_FILE}.out" "\${DOCKERFILE}"
rm -f "\${ARGS_FILE}"

echo "=== Dockerfile updated with build args ==="
head -n 20 "\${DOCKERFILE}"
`;
}
