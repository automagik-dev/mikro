#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

SOURCE="$TMP/source"
INSTALL_DIR="$TMP/install"
BIN_DIR="$TMP/bin"

copy_worktree() {
  mkdir -p "$SOURCE"
  tar \
    --exclude='.git' \
    --exclude='node_modules' \
    --exclude='.DS_Store' \
    -C "$ROOT" \
    -cf - . | tar -C "$SOURCE" -xf -
}

commit_source() {
  git -C "$SOURCE" add -A
  git -C "$SOURCE" commit -m "$1" >/dev/null
}

copy_worktree

git init -b main "$SOURCE" >/dev/null
git -C "$SOURCE" config user.name "rlmx-ci"
git -C "$SOURCE" config user.email "rlmx-ci@example.invalid"
commit_source "test: seed install smoke source"
INITIAL_HEAD="$(git -C "$SOURCE" rev-parse HEAD)"

echo "==> Smoke install from local main checkout"
RLMX_REPO_URL="$SOURCE" \
RLMX_BRANCH=main \
RLMX_INSTALL_DIR="$INSTALL_DIR" \
RLMX_BIN_DIR="$BIN_DIR" \
  bash "$ROOT/scripts/install.sh"

INSTALLED_HEAD="$(git -C "$INSTALL_DIR" rev-parse HEAD)"
if [ "$INSTALLED_HEAD" != "$INITIAL_HEAD" ]; then
  echo "::error::install head mismatch: installed=$INSTALLED_HEAD source=$INITIAL_HEAD" >&2
  exit 1
fi

"$BIN_DIR/rlmx" --version || {
  echo "::error::installed rlmx binary failed" >&2
  exit 1
}

npm pack --json --dry-run | node -e 'let s=""; process.stdin.on("data",d=>s+=d); process.stdin.on("end",()=>{ const p=JSON.parse(s)[0]; if (p.bin) { console.error("npm package exposes bin unexpectedly", p.bin); process.exit(1); } });' || {
  echo "::error::npm package must remain SDK-only and expose no bin" >&2
  exit 1
}
echo "==> npm package is SDK-only: no bin exposed"

echo "==> Smoke update dirty-check refusal"
printf '\n# dirty smoke\n' >> "$INSTALL_DIR/docs/release-contract.md"
if "$BIN_DIR/rlmx" update >"$TMP/dirty.out" 2>"$TMP/dirty.err"; then
  echo "::error::rlmx update succeeded despite dirty checkout" >&2
  cat "$TMP/dirty.out" >&2
  cat "$TMP/dirty.err" >&2
  exit 1
fi
if ! grep -q 'Refusing to update with local changes' "$TMP/dirty.err"; then
  echo "::error::dirty-check error message missing" >&2
  cat "$TMP/dirty.err" >&2
  exit 1
fi

git -C "$INSTALL_DIR" reset --hard HEAD >/dev/null
git -C "$INSTALL_DIR" clean -fd >/dev/null

echo "==> Smoke update happy path from advanced main"
printf '\nupdate-smoke=%s\n' "$(date -u +%Y%m%dT%H%M%SZ)" >> "$SOURCE/.rlmx-update-smoke"
commit_source "test: advance main for update smoke"
TARGET_HEAD="$(git -C "$SOURCE" rev-parse HEAD)"

"$BIN_DIR/rlmx" update
UPDATED_HEAD="$(git -C "$INSTALL_DIR" rev-parse HEAD)"
if [ "$UPDATED_HEAD" != "$TARGET_HEAD" ]; then
  echo "::error::update head mismatch: installed=$UPDATED_HEAD source=$TARGET_HEAD" >&2
  exit 1
fi

echo "==> Install/update smoke passed"
echo "initial: $INITIAL_HEAD"
echo "target:  $TARGET_HEAD"
