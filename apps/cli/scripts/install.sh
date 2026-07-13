#!/bin/sh
# Orchard CLI installer.
#
# Releases live in the LeafdTK/leaf monorepo and are tagged cli/vX.Y.Z
# (release-please component tags). Asset names come from apps/cli/.goreleaser.yaml:
#   orchard_<version>_<os>_<arch>.tar.gz (zip on windows) + checksums.txt
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/LeafdTK/leaf/main/apps/cli/scripts/install.sh | sh

set -eu

REPO="LeafdTK/leaf"

say() { printf '%s\n' "$*"; }
die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- "$1"
  else
    die "curl or wget is required"
  fi
}

download() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -o "$2" "$1"
  else
    wget -qO "$2" "$1"
  fi
}

OS=$(uname -s)
case "$OS" in
  Darwin) OS=darwin ;;
  Linux) OS=linux ;;
  MINGW* | MSYS* | CYGWIN* | Windows_NT)
    die "windows is not supported by this script; grab the orchard_<version>_windows_<arch>.zip asset from https://github.com/${REPO}/releases" ;;
  *) die "unsupported OS: ${OS} (supported: darwin, linux)" ;;
esac

ARCH=$(uname -m)
case "$ARCH" in
  x86_64 | amd64) ARCH=amd64 ;;
  arm64 | aarch64) ARCH=arm64 ;;
  *) die "unsupported architecture: ${ARCH} (supported: amd64, arm64)" ;;
esac

say "finding the latest orchard cli release..."
TAG=$(fetch "https://api.github.com/repos/${REPO}/releases?per_page=100" |
  grep -o '"tag_name": *"cli/v[0-9][^"]*"' | head -n 1 | cut -d'"' -f4)
[ -n "${TAG}" ] || die "no cli/v* release found in the latest 100 releases of ${REPO}"
VERSION=${TAG#cli/v}

ARCHIVE="orchard_${VERSION}_${OS}_${ARCH}.tar.gz"
BASE_URL="https://github.com/${REPO}/releases/download/cli%2Fv${VERSION}"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM

say "downloading ${ARCHIVE} (${TAG})..."
download "${BASE_URL}/${ARCHIVE}" "${TMP}/${ARCHIVE}"
download "${BASE_URL}/checksums.txt" "${TMP}/checksums.txt"

cd "$TMP"
SUM_LINE=$(grep " ${ARCHIVE}\$" checksums.txt) ||
  die "no entry for ${ARCHIVE} in checksums.txt"
if command -v sha256sum >/dev/null 2>&1; then
  printf '%s\n' "$SUM_LINE" | sha256sum -c - >/dev/null 2>&1 ||
    die "sha256 verification failed for ${ARCHIVE}"
elif command -v shasum >/dev/null 2>&1; then
  printf '%s\n' "$SUM_LINE" | shasum -a 256 -c - >/dev/null 2>&1 ||
    die "sha256 verification failed for ${ARCHIVE}"
else
  die "sha256sum or shasum is required to verify the download"
fi

tar -xzf "${ARCHIVE}"
[ -f orchard ] || die "orchard binary not found in ${ARCHIVE}"

if [ -d /usr/local/bin ] && [ -w /usr/local/bin ]; then
  DEST=/usr/local/bin
else
  DEST="${HOME}/.local/bin"
  mkdir -p "$DEST"
fi

cp orchard "${DEST}/.orchard.new"
chmod 0755 "${DEST}/.orchard.new"
mv -f "${DEST}/.orchard.new" "${DEST}/orchard"

say "installed $("${DEST}/orchard" --version) to ${DEST}/orchard"
case ":${PATH}:" in
  *":${DEST}:"*) ;;
  *) say "note: ${DEST} is not on your PATH; add it in your shell profile" ;;
esac
