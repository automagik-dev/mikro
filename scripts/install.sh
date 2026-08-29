#!/usr/bin/env bash
set -euo pipefail

MIKRO_REPO_URL="${MIKRO_REPO_URL:-https://github.com/automagik-dev/mikro.git}"
MIKRO_BRANCH="${MIKRO_BRANCH:-main}"
MIKRO_INSTALL_DIR="${MIKRO_INSTALL_DIR:-$HOME/.mikro/mikro}"
MIKRO_BIN_DIR="${MIKRO_BIN_DIR:-$HOME/.local/bin}"

echo "==> Installing MIKRO"
echo "repo:   $MIKRO_REPO_URL"
echo "branch: $MIKRO_BRANCH"
echo "dir:    $MIKRO_INSTALL_DIR"
echo "bin:    $MIKRO_BIN_DIR"

LEGACY_HOME="$HOME/.rlmx"
if [ -d "$LEGACY_HOME" ] && [ ! -e "$HOME/.mikro" ]; then
  echo "==> Migrating legacy $LEGACY_HOME -> $HOME/.mikro"
  mv "$LEGACY_HOME" "$HOME/.mikro"
  if [ -d "$HOME/.mikro/rlmx" ] && [ ! -e "$HOME/.mikro/mikro" ]; then
    mv "$HOME/.mikro/rlmx" "$HOME/.mikro/mikro"
  fi
  if [ -L "$MIKRO_BIN_DIR/rlmx" ]; then
    rm -f "$MIKRO_BIN_DIR/rlmx"
  fi
fi

mkdir -p "$MIKRO_BIN_DIR" "$(dirname "$MIKRO_INSTALL_DIR")"

if [ -d "$MIKRO_INSTALL_DIR/.git" ]; then
  echo "==> Existing checkout found; refreshing"
  git -C "$MIKRO_INSTALL_DIR" remote set-url origin "$MIKRO_REPO_URL"
  git -C "$MIKRO_INSTALL_DIR" fetch origin "$MIKRO_BRANCH" --tags
  git -C "$MIKRO_INSTALL_DIR" checkout -f "$MIKRO_BRANCH"
  git -C "$MIKRO_INSTALL_DIR" reset --hard "origin/$MIKRO_BRANCH"
  git -C "$MIKRO_INSTALL_DIR" clean -fd
else
  if [ -e "$MIKRO_INSTALL_DIR" ]; then
    echo "error: $MIKRO_INSTALL_DIR exists but is not a git checkout" >&2
    exit 1
  fi
  echo "==> Cloning"
  git clone --branch "$MIKRO_BRANCH" "$MIKRO_REPO_URL" "$MIKRO_INSTALL_DIR"
fi

cd "$MIKRO_INSTALL_DIR"

echo "==> Installing dependencies"
npm ci --include=dev

echo "==> Building"
npm run build

ln -sfn "$MIKRO_INSTALL_DIR/dist/src/cli.js" "$MIKRO_BIN_DIR/mikro"
chmod +x "$MIKRO_INSTALL_DIR/dist/src/cli.js"

echo "==> Installed"
"$MIKRO_BIN_DIR/mikro" --version
