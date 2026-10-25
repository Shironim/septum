#!/bin/sh
set -e

# ==============================================================================
# Septum Standalone Binary Installer (Linux & macOS)
# https://github.com/Shironim/septum
# ==============================================================================

REPO="Shironim/septum"
BINARY_NAME="septum"

# Color support
if [ -t 1 ]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  CYAN='\033[0;36m'
  YELLOW='\033[0;33m'
  BOLD='\033[1m'
  NC='\033[0m'
else
  RED=''
  GREEN=''
  CYAN=''
  YELLOW=''
  BOLD=''
  NC=''
fi

info() {
  printf "${CYAN}[info]${NC} %s\n" "$1"
}

success() {
  printf "${GREEN}[success]${NC} ${BOLD}%s${NC}\n" "$1"
}

warn() {
  printf "${YELLOW}[warn]${NC} %s\n" "$1"
}

error() {
  printf "${RED}[error]${NC} %s\n" "$1" >&2
  exit 1
}

# 1. Detect OS
OS_RAW=$(uname -s)
case "${OS_RAW}" in
  Linux*)  OS="linux" ;;
  Darwin*) OS="darwin" ;;
  MINGW*|MSYS*|CYGWIN*)
    error "Windows shell detected. Please use PowerShell installer: irm https://raw.githubusercontent.com/${REPO}/master/install.ps1 | iex"
    ;;
  *)
    error "Unsupported operating system: ${OS_RAW}"
    ;;
esac

# 2. Detect Architecture
ARCH_RAW=$(uname -m)
case "${ARCH_RAW}" in
  x86_64|amd64) ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *)
    error "Unsupported system architecture: ${ARCH_RAW}. Septum provides prebuilt binaries for x64 and arm64."
    ;;
esac

TARGET="septum-${OS}-${ARCH}"
info "Detected platform: ${OS}-${ARCH} (target: ${TARGET})"

# 3. Determine download URL
if [ -n "${VERSION}" ]; then
  TAG="${VERSION}"
  BASE_URL="https://github.com/${REPO}/releases/download/${TAG}"
  info "Installing specified version: ${TAG}"
else
  BASE_URL="https://github.com/${REPO}/releases/latest/download"
  info "Fetching latest release from GitHub..."
fi

DOWNLOAD_URL="${BASE_URL}/${TARGET}"
CHECKSUM_URL="${BASE_URL}/checksums.txt"

# 4. Check downloader utility
if command -v curl >/dev/null 2>&1; then
  DOWNLOAD_CMD="curl -fL --progress-bar"
elif command -v wget >/dev/null 2>&1; then
  DOWNLOAD_CMD="wget -q --show-progress -O"
else
  error "Neither 'curl' nor 'wget' was found on your system. Please install one of them."
fi

# 5. Determine installation directory
if [ -n "${SEPTUM_INSTALL_DIR}" ]; then
  INSTALL_DIR="${SEPTUM_INSTALL_DIR}"
elif [ -w "/usr/local/bin" ]; then
  INSTALL_DIR="/usr/local/bin"
elif [ "$(id -u)" -eq 0 ]; then
  INSTALL_DIR="/usr/local/bin"
else
  INSTALL_DIR="${HOME}/.local/bin"
fi

mkdir -p "${INSTALL_DIR}" 2>/dev/null || {
  error "Failed to create installation directory: ${INSTALL_DIR}"
}

TMP_DIR=$(mktemp -d 2>/dev/null || mktemp -d -t 'septum-install')
cleanup() {
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT INT TERM

info "Downloading ${TARGET}..."
TMP_BIN="${TMP_DIR}/${BINARY_NAME}"

if command -v curl >/dev/null 2>&1; then
  curl -fsSL "${DOWNLOAD_URL}" -o "${TMP_BIN}" || error "Failed to download binary from: ${DOWNLOAD_URL}"
else
  wget -q -O "${TMP_BIN}" "${DOWNLOAD_URL}" || error "Failed to download binary from: ${DOWNLOAD_URL}"
fi

# 6. Optional Checksum Verification
if command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1; then
  TMP_CHECKSUMS="${TMP_DIR}/checksums.txt"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "${CHECKSUM_URL}" -o "${TMP_CHECKSUMS}" 2>/dev/null || true
  else
    wget -q -O "${TMP_CHECKSUMS}" "${CHECKSUM_URL}" 2>/dev/null || true
  fi

  if [ -s "${TMP_CHECKSUMS}" ]; then
    info "Verifying SHA256 checksum..."
    EXPECTED_SHA=$(grep "${TARGET}" "${TMP_CHECKSUMS}" | awk '{print $1}')
    if [ -n "${EXPECTED_SHA}" ]; then
      if command -v sha256sum >/dev/null 2>&1; then
        ACTUAL_SHA=$(sha256sum "${TMP_BIN}" | awk '{print $1}')
      else
        ACTUAL_SHA=$(shasum -a 256 "${TMP_BIN}" | awk '{print $1}')
      fi

      if [ "${EXPECTED_SHA}" != "${ACTUAL_SHA}" ]; then
        error "Checksum verification failed! Expected: ${EXPECTED_SHA}, Actual: ${ACTUAL_SHA}"
      fi
      info "Checksum verified: ${ACTUAL_SHA}"
    fi
  fi
fi

chmod +x "${TMP_BIN}"

# 7. Move binary into place
TARGET_BIN="${INSTALL_DIR}/${BINARY_NAME}"
if [ -w "${INSTALL_DIR}" ]; then
  mv -f "${TMP_BIN}" "${TARGET_BIN}"
else
  info "Escalating privileges with sudo to install into ${INSTALL_DIR}..."
  sudo mv -f "${TMP_BIN}" "${TARGET_BIN}"
  sudo chmod +x "${TARGET_BIN}"
fi

# 8. Check PATH availability
PATH_WARNING=""
case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) ;;
  *)
    PATH_WARNING=1
    ;;
esac

# 9. Verification
INSTALLED_VER=$("${TARGET_BIN}" --version 2>/dev/null || true)

printf "\n"
success "Septum successfully installed at: ${TARGET_BIN}"
if [ -n "${INSTALLED_VER}" ]; then
  printf "       %s\n" "${INSTALLED_VER}"
fi

if [ -n "${PATH_WARNING}" ]; then
  warn "Directory '${INSTALL_DIR}' is not currently in your system PATH."
  printf "\nTo make 'septum' accessible globally, add this line to your shell configuration profile (~/.bashrc, ~/.zshrc, or ~/.profile):\n\n"
  printf "  ${BOLD}export PATH=\"%s:\$PATH\"${NC}\n\n" "${INSTALL_DIR}"
  printf "Then reload your shell: ${BOLD}source ~/.bashrc${NC} (or ~/.zshrc)\n"
fi

printf "\n${BOLD}Quick Start:${NC}\n"
printf "  1. Run ${CYAN}septum init${NC} in your codebase to configure bounded contexts.\n"
printf "  2. Run ${CYAN}septum serve${NC} to launch the MCP server for AI coding agents.\n\n"

