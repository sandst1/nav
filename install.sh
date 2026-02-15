#!/usr/bin/env bash
# nav installer - downloads and installs the appropriate binary for your platform
set -euo pipefail

REPO="sandst1/nav"  # Replace with your actual GitHub username/org and repo
VERSION="${NAV_VERSION:-latest}"
INSTALL_DIR="${NAV_INSTALL_DIR:-$HOME/.local/bin}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log() {
  echo -e "${GREEN}==>${NC} $*"
}

warn() {
  echo -e "${YELLOW}Warning:${NC} $*" >&2
}

error() {
  echo -e "${RED}Error:${NC} $*" >&2
  exit 1
}

# Detect platform and architecture
detect_platform() {
  local os arch

  # Detect OS
  case "$(uname -s)" in
    Darwin)
      os="darwin"
      ;;
    Linux)
      os="linux"
      ;;
    MINGW*|MSYS*|CYGWIN*)
      os="windows"
      ;;
    *)
      error "Unsupported operating system: $(uname -s)"
      ;;
  esac

  # Detect architecture
  case "$(uname -m)" in
    x86_64|amd64)
      arch="x64"
      ;;
    arm64|aarch64)
      arch="arm64"
      ;;
    *)
      error "Unsupported architecture: $(uname -m)"
      ;;
  esac

  echo "${os}-${arch}"
}

# Get latest release version
get_latest_version() {
  if command -v curl >/dev/null 2>&1; then
    curl -sSfL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name":' | sed -E 's/.*"([^"]+)".*/\1/'
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name":' | sed -E 's/.*"([^"]+)".*/\1/'
  else
    error "curl or wget is required to download nav"
  fi
}

# Download and verify binary
download_and_install() {
  local platform="$1"
  local version="$2"
  local archive_ext
  local download_tool

  # Determine archive extension
  if [[ "$platform" == "windows-"* ]]; then
    archive_ext="zip"
  else
    archive_ext="tar.gz"
  fi

  local filename="nav-${platform}.${archive_ext}"
  local url="https://github.com/${REPO}/releases/download/${version}/${filename}"
  local checksum_url="${url}.sha256"

  log "Downloading nav ${version} for ${platform}..."

  # Create temp directory
  local temp_dir
  temp_dir=$(mktemp -d)
  trap "rm -rf '$temp_dir'" EXIT

  # Download with curl or wget
  if command -v curl >/dev/null 2>&1; then
    download_tool="curl"
    curl -fsSL "$url" -o "${temp_dir}/${filename}"
    curl -fsSL "$checksum_url" -o "${temp_dir}/${filename}.sha256"
  elif command -v wget >/dev/null 2>&1; then
    download_tool="wget"
    wget -q "$url" -O "${temp_dir}/${filename}"
    wget -q "$checksum_url" -O "${temp_dir}/${filename}.sha256"
  else
    error "curl or wget is required to download nav"
  fi

  # Verify checksum
  log "Verifying checksum..."
  cd "$temp_dir"
  
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 -c "${filename}.sha256" || error "Checksum verification failed"
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum -c "${filename}.sha256" || error "Checksum verification failed"
  else
    warn "sha256sum not found, skipping checksum verification"
  fi

  # Extract binary
  log "Extracting..."
  if [[ "$archive_ext" == "tar.gz" ]]; then
    tar -xzf "$filename"
    binary_name="nav-${platform}"
  else
    unzip -q "$filename"
    binary_name="nav-${platform}.exe"
  fi

  # Install binary
  mkdir -p "$INSTALL_DIR"
  
  local install_path
  if [[ "$platform" == "windows-"* ]]; then
    install_path="${INSTALL_DIR}/nav.exe"
  else
    install_path="${INSTALL_DIR}/nav"
  fi

  log "Installing to ${install_path}..."
  mv "$binary_name" "$install_path"
  chmod +x "$install_path"

  log "${GREEN}nav ${version} installed successfully!${NC}"
  echo
  
  # Check if install dir is in PATH
  if [[ ":$PATH:" != *":${INSTALL_DIR}:"* ]]; then
    warn "Add ${INSTALL_DIR} to your PATH to use nav:"
    echo "  export PATH=\"\$PATH:${INSTALL_DIR}\""
    echo
    echo "Add this to your shell config (~/.bashrc, ~/.zshrc, etc.)"
  else
    log "Run 'nav' to get started!"
  fi
}

# Main
main() {
  log "nav installer"
  echo

  # Detect platform
  local platform
  platform=$(detect_platform)
  log "Detected platform: ${platform}"

  # Get version
  local version="$VERSION"
  if [[ "$version" == "latest" ]]; then
    version=$(get_latest_version)
    log "Latest version: ${version}"
  fi

  # Download and install
  download_and_install "$platform" "$version"
}

main "$@"
