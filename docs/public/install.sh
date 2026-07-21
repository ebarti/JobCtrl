#!/usr/bin/env bash
# Transport-only JobCtrl bootstrap: no clone and no developer toolchain.
set -euo pipefail

# P6 renders these from the signed publication. Empty pins fail closed.
# BEGIN JOBCTRL RELEASE PINS
INSTALLER_URL=""
INSTALLER_SHA256=""
INSTALLER_VERSION=""
# END JOBCTRL RELEASE PINS

usage() {
  cat <<'EOF'
Usage: scripts/get [--home <runtime-home>] [--bin-dir <directory>] [--no-modify-path] [--release-url <https-url>]
       scripts/get --local-fixture-contract <path> [--home <runtime-home>]

The normal path needs a published P6 native-installer pin. The local fixture
route cannot select a network release.
EOF
}
fail() { printf 'get: %s\n' "$1" >&2; exit 1; }
require_darwin_arm64() {
  [[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]] || fail "JobCtrl currently supports only Apple-silicon macOS (darwin-arm64)."
}
sha256_file() { /usr/bin/shasum -a 256 "$1" | /usr/bin/awk '{print $1}'; }
is_sha256() { [[ "$1" =~ ^[a-f0-9]{64}$ ]]; }
fixture_value() {
  local contract key matches value
  contract="$1"
  key="$2"
  matches="$(/usr/bin/grep -E "^${key}=" "$contract" || true)"
  [[ -n "$matches" && "$matches" != *$'\n'* ]] || fail "fixture contract must contain exactly one ${key} entry"
  value="${matches#*=}"
  [[ "$value" != *$'\n'* && -n "$value" ]] || fail "fixture contract has invalid ${key}"
  /usr/bin/printf '%s' "$value"
}
download_installer() {
  local source_url="$1" destination="$2" local_fixture="$3"
  if [[ "$local_fixture" == "1" ]]; then
    [[ "$source_url" == file://* ]] || fail "fixture installer URL must use file://"
    local source_path="${source_url#file://}"
    [[ -f "$source_path" && ! -L "$source_path" ]] || fail "fixture installer is not a regular file"
    /bin/cp "$source_path" "$destination"
    return
  fi
  [[ "$source_url" == https://* ]] || fail "published installer URL must use HTTPS"
  /usr/bin/curl --fail --silent --show-error --proto '=https' --max-redirs 0 --connect-timeout 15 --max-time 120 --output "$destination" "$source_url"
}

path_contains() {
  local wanted="$1" current=":${PATH:-}:"
  [[ "$current" == *":$wanted:"* ]]
}
require_safe_profile_path() {
  local value="$1" label="$2"
  [[ "$value" == /* ]] || fail "$label must be an absolute path"
  case "$value" in
    *$'\n'*|*$'\r'*|*\"*|*\'*|*'`'*|*'$'*|*\\*|*:*) fail "$label contains unsafe characters" ;;
  esac
  if LC_ALL=C /usr/bin/printf '%s' "$value" | /usr/bin/grep -q '[[:cntrl:]]'; then
    fail "$label contains control characters"
  fi
}
runtime_home() {
  if [[ -n "$HOME_OVERRIDE" ]]; then /usr/bin/printf '%s' "$HOME_OVERRIDE"; return; fi
  if [[ -n "${JOBCTRL_RUNTIME_HOME:-}" ]]; then /usr/bin/printf '%s' "$JOBCTRL_RUNTIME_HOME"; return; fi
  /usr/bin/printf '%s' "$HOME/Library/Application Support/JobCtrl"
}
login_profile() {
  case "${SHELL:-/bin/zsh}" in
    */bash) /usr/bin/printf '%s' "$HOME/.bash_profile" ;;
    *) /usr/bin/printf '%s' "$HOME/.zprofile" ;;
  esac
}
append_managed_path() {
  local bin_dir="$1" profile mode temporary line
  profile="$(login_profile)"
  require_safe_profile_path "$profile" "login profile"
  line="export PATH=\"$bin_dir:\$PATH\" # JobCtrl managed path"
  if [[ -L "$profile" ]]; then fail "refusing to modify symlinked login profile $profile"; fi
  if [[ -e "$profile" && ! -f "$profile" ]]; then fail "login profile is not a regular file: $profile"; fi
  if [[ -f "$profile" ]] && /usr/bin/grep -Fqx "$line" "$profile"; then return; fi
  if [[ -f "$profile" ]]; then
    mode="$(/usr/bin/stat -f '%Lp' "$profile")"
    temporary="$(/usr/bin/mktemp "${profile}.jobctrl.XXXXXX")"
    /bin/cat "$profile" > "$temporary" || { /bin/rm -f "$temporary"; fail "could not read login profile $profile"; }
    /usr/bin/printf '\n%s\n' "$line" >> "$temporary" || { /bin/rm -f "$temporary"; fail "could not update login profile $profile"; }
    /bin/chmod "$mode" "$temporary" || { /bin/rm -f "$temporary"; fail "could not preserve login profile mode"; }
    /bin/mv -f "$temporary" "$profile" || { /bin/rm -f "$temporary"; fail "could not atomically update login profile"; }
  else
    (umask 077; /usr/bin/printf '%s\n' "$line" > "$profile")
  fi
  /usr/bin/printf 'Added JobCtrl to %s. Open a new terminal, or run: export PATH=\"%s:$PATH\"\n' "$profile" "$bin_dir"
}
expose_command() {
  local release_home="$1" bin_dir="$2" selector link target
  selector="$release_home/bin/jobctrl"
  [[ -x "$selector" && ! -L "$selector" ]] || fail "native installer did not create executable runtime selector $selector"
  if [[ -L "$bin_dir" ]]; then fail "refusing symlinked --bin-dir $bin_dir"; fi
  if [[ ! -d "$bin_dir" ]]; then /bin/mkdir -p "$bin_dir"; fi
  [[ -d "$bin_dir" && ! -L "$bin_dir" ]] || fail "--bin-dir is not a regular directory: $bin_dir"
  link="$bin_dir/jobctrl"
  if [[ -L "$link" ]]; then
    target="$(/usr/bin/readlink "$link")"
    [[ "$target" == "$selector" ]] || fail "refusing to replace unrelated jobctrl symlink $link"
  elif [[ -e "$link" ]]; then
    fail "refusing to replace existing non-symlink command $link"
  else
    /bin/ln -s "$selector" "$link" || fail "could not create public command link $link"
  fi
  if path_contains "$bin_dir"; then
    /usr/bin/printf 'JobCtrl is ready: jobctrl\n'
  elif [[ "$NO_MODIFY_PATH" -eq 1 ]]; then
    /usr/bin/printf 'JobCtrl installed at %s. For this terminal run: export PATH=\"%s:$PATH\"; then run jobctrl.\n' "$link" "$bin_dir"
  else
    append_managed_path "$bin_dir"
  fi
}
persist_curl_acquisition() {
  local release_home="$1" bin_dir="$2" profile encoded_line record temporary
  profile=""
  encoded_line=""
  if [[ "$NO_MODIFY_PATH" -eq 0 ]] && ! path_contains "$bin_dir"; then
    profile="$(login_profile)"
    require_safe_profile_path "$profile" "login profile"
    encoded_line="export PATH=\\\"$bin_dir:\$PATH\\\" # JobCtrl managed path"
  fi
  record="$release_home/acquisition.json"
  [[ ! -L "$record" ]] || fail "refusing symlinked acquisition record $record"
  temporary="$(/usr/bin/mktemp "$release_home/.acquisition.XXXXXX")"
  /usr/bin/printf '{"schemaVersion":1,"source":"curl","publicLink":"%s/jobctrl","selector":"%s/bin/jobctrl","profile":"%s","pathLine":"%s"}\n' "$bin_dir" "$release_home" "$profile" "$encoded_line" > "$temporary" || { /bin/rm -f "$temporary"; fail "could not write acquisition record"; }
  /bin/chmod 0600 "$temporary"
  /bin/mv -f "$temporary" "$record" || { /bin/rm -f "$temporary"; fail "could not commit acquisition record"; }
}

HOME_OVERRIDE=""
BIN_DIR_OVERRIDE=""
NO_MODIFY_PATH=0
RELEASE_URL=""
FIXTURE_CONTRACT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --home) [[ $# -ge 2 ]] || fail "--home requires a path"; HOME_OVERRIDE="$2"; shift 2 ;;
    --bin-dir) [[ $# -ge 2 ]] || fail "--bin-dir requires a directory"; BIN_DIR_OVERRIDE="$2"; shift 2 ;;
    --no-modify-path) NO_MODIFY_PATH=1; shift ;;
    --release-url) [[ $# -ge 2 ]] || fail "--release-url requires a URL"; RELEASE_URL="$2"; shift 2 ;;
    --local-fixture-contract) [[ $# -ge 2 ]] || fail "--local-fixture-contract requires a path"; FIXTURE_CONTRACT="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown option $1" ;;
  esac
done

require_darwin_arm64
TMP_ROOT="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/jobctrl-get.XXXXXX")"
trap '/bin/rm -rf "$TMP_ROOT"' EXIT HUP INT TERM
INSTALLER_PATH="$TMP_ROOT/jobctrl-installer"
if [[ -n "$FIXTURE_CONTRACT" ]]; then
  [[ -z "$RELEASE_URL" ]] || fail "local fixture mode cannot use --release-url"
  [[ -f "$FIXTURE_CONTRACT" && ! -L "$FIXTURE_CONTRACT" ]] || fail "fixture contract must be a regular file"
  fixture_mode="$(fixture_value "$FIXTURE_CONTRACT" MODE)"
  [[ "$fixture_mode" == "local-fixture" ]] || fail "fixture contract MODE must be local-fixture (received $fixture_mode)"
  [[ "$(fixture_value "$FIXTURE_CONTRACT" PLATFORM)" == "darwin-arm64" ]] || fail "fixture contract platform must be darwin-arm64"
  INSTALLER_URL="$(fixture_value "$FIXTURE_CONTRACT" INSTALLER_URL)"
  INSTALLER_SHA256="$(fixture_value "$FIXTURE_CONTRACT" INSTALLER_SHA256)"
  INSTALLER_VERSION="$(fixture_value "$FIXTURE_CONTRACT" INSTALLER_VERSION)"
  LOCAL_FIXTURE=1
else
  LOCAL_FIXTURE=0
  [[ -n "$INSTALLER_URL" && -n "$INSTALLER_VERSION" ]] || fail "no signed native installer is published yet; P6 release signing is still blocked"
fi
is_sha256 "$INSTALLER_SHA256" || fail "installer SHA-256 is missing or invalid"
download_installer "$INSTALLER_URL" "$INSTALLER_PATH" "$LOCAL_FIXTURE"
actual_sha="$(sha256_file "$INSTALLER_PATH")"
[[ "$actual_sha" == "$INSTALLER_SHA256" ]] || fail "installer SHA-256 mismatch (expected $INSTALLER_SHA256, received $actual_sha)"
/bin/chmod 0700 "$INSTALLER_PATH"
installer_args=()
[[ -n "$HOME_OVERRIDE" ]] && installer_args+=(--home "$HOME_OVERRIDE")
RELEASE_HOME="$(runtime_home)"
BIN_DIR="${BIN_DIR_OVERRIDE:-$HOME/.local/bin}"
require_safe_profile_path "$RELEASE_HOME" "runtime home"
require_safe_profile_path "$BIN_DIR" "--bin-dir"
if [[ "$LOCAL_FIXTURE" == "1" ]]; then
  descriptor="$(fixture_value "$FIXTURE_CONTRACT" DESCRIPTOR_FILE)"
  signature="$(fixture_value "$FIXTURE_CONTRACT" SIGNATURE_FILE)"
  archive="$(fixture_value "$FIXTURE_CONTRACT" ARCHIVE_FILE)"
  "$INSTALLER_PATH" --allow-unsigned-local --descriptor-file "$descriptor" --signature-file "$signature" --archive-file "$archive" ${installer_args[@]+"${installer_args[@]}"}
else
  [[ -n "$RELEASE_URL" ]] && installer_args+=(--release-url "$RELEASE_URL")
  "$INSTALLER_PATH" ${installer_args[@]+"${installer_args[@]}"}
fi
persist_curl_acquisition "$RELEASE_HOME" "$BIN_DIR"
expose_command "$RELEASE_HOME" "$BIN_DIR"
