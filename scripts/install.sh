#!/usr/bin/env bash
set -euo pipefail

RLMX_REPO_URL="${RLMX_REPO_URL:-https://github.com/automagik-dev/rlmx.git}"
RLMX_BRANCH="${RLMX_BRANCH:-main}"
RLMX_INSTALL_DIR="${RLMX_INSTALL_DIR:-$HOME/.rlmx/rlmx}"
RLMX_BIN_DIR="${RLMX_BIN_DIR:-$HOME/.local/bin}"

echo "==> Installing RLMX"
echo "repo:   $RLMX_REPO_URL"
echo "branch: $RLMX_BRANCH"
echo "dir:    $RLMX_INSTALL_DIR"
echo "bin:    $RLMX_BIN_DIR"

mkdir -p "$RLMX_BIN_DIR" "$(dirname "$RLMX_INSTALL_DIR")"

if [ -d "$RLMX_INSTALL_DIR/.git" ]; then
  echo "==> Existing checkout found; refreshing"
  git -C "$RLMX_INSTALL_DIR" fetch origin "$RLMX_BRANCH" --tags
  git -C "$RLMX_INSTALL_DIR" checkout "$RLMX_BRANCH"
  git -C "$RLMX_INSTALL_DIR" reset --hard "origin/$RLMX_BRANCH"
else
  if [ -e "$RLMX_INSTALL_DIR" ]; then
    echo "error: $RLMX_INSTALL_DIR exists but is not a git checkout" >&2
    exit 1
  fi
  echo "==> Cloning"
  git clone --branch "$RLMX_BRANCH" "$RLMX_REPO_URL" "$RLMX_INSTALL_DIR"
fi

cd "$RLMX_INSTALL_DIR"

echo "==> Installing dependencies"
npm ci

echo "==> Building"
npm run build

ln -sfn "$RLMX_INSTALL_DIR/dist/src/cli.js" "$RLMX_BIN_DIR/rlmx"
chmod +x "$RLMX_INSTALL_DIR/dist/src/cli.js"

echo "==> Installed"
"$RLMX_BIN_DIR/rlmx" --version
