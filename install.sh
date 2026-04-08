#!/usr/bin/env bash
set -euo pipefail

REPO="SpaceK33z/autoauto"
INSTALL_DIR="${AUTOAUTO_INSTALL_DIR:-/usr/local/bin}"

# Detect platform
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin) os="darwin" ;;
  Linux)  os="linux" ;;
  *)
    echo "Error: unsupported OS: $OS" >&2
    exit 1
    ;;
esac

case "$ARCH" in
  arm64|aarch64) arch="arm64" ;;
  x86_64|amd64)  arch="x64" ;;
  *)
    echo "Error: unsupported architecture: $ARCH" >&2
    exit 1
    ;;
esac

ARTIFACT="autoauto-${os}-${arch}"

# Get latest release tag
if [ -n "${AUTOAUTO_VERSION:-}" ]; then
  TAG="v${AUTOAUTO_VERSION#v}"
else
  TAG="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | cut -d '"' -f 4)"
  if [ -z "$TAG" ]; then
    echo "Error: could not determine latest release" >&2
    exit 1
  fi
fi

URL="https://github.com/${REPO}/releases/download/${TAG}/${ARTIFACT}"

echo "Installing autoauto ${TAG} (${os}/${arch})..."

# Download binary
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

if ! curl -fSL --progress-bar -o "$TMP" "$URL"; then
  echo "Error: failed to download ${URL}" >&2
  echo "Check that a release exists for your platform at https://github.com/${REPO}/releases" >&2
  exit 1
fi

chmod +x "$TMP"

# Install — try without sudo first
if [ -w "$INSTALL_DIR" ]; then
  mv "$TMP" "${INSTALL_DIR}/autoauto"
else
  echo "Need sudo to install to ${INSTALL_DIR}"
  sudo mv "$TMP" "${INSTALL_DIR}/autoauto"
fi

echo "Installed autoauto to ${INSTALL_DIR}/autoauto"
echo "Run 'autoauto' to get started."
