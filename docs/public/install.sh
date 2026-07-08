#!/usr/bin/env bash
# JobCtrl one-line bootstrap: clone (or update) the repo, then hand off to
# the interactive installer. Safe to run via `curl ... | bash`.

set -euo pipefail

REPO_URL="${JOBCTRL_REPO_URL:-https://github.com/ebarti/JobCtrl.git}"
TARGET_DIR="${JOBCTRL_HOME:-$HOME/JobCtrl}"

ASSUME_YES=0
INSTALL_ARGS=()

usage() {
  cat <<'EOF'
Usage:
  curl -fsSL https://jobctrl.dev/install.sh | bash
  scripts/get [options] [-- <scripts/install options>]

Clones JobCtrl to $JOBCTRL_HOME (default: ~/JobCtrl), or fast-forwards an
existing clone, then runs the guided installer (scripts/install) inside it.

Options:
  --dir <path>   Install location (default: $JOBCTRL_HOME or ~/JobCtrl).
  -y, --yes      Non-interactive: accept installer defaults.
  -h, --help     Show this help.

Any options after `--` are passed to scripts/install unchanged.
EOF
}

fail() {
  printf 'get: %s\n' "$1" >&2
  exit 1
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --dir)
      [[ "$#" -ge 2 ]] || fail "--dir needs a path"
      TARGET_DIR="$2"
      shift
      ;;
    -y|--yes) ASSUME_YES=1 ;;
    -h|--help) usage; exit 0 ;;
    --)
      shift
      if [[ "$#" -gt 0 ]]; then
        INSTALL_ARGS+=("$@")
      fi
      break
      ;;
    *) fail "unknown option '$1' (see --help)" ;;
  esac
  shift
done

command -v git >/dev/null 2>&1 || fail "git is required first (macOS: xcode-select --install)"

if [[ -d "$TARGET_DIR/.git" ]]; then
  printf '==> Updating existing clone at %s\n' "$TARGET_DIR"
  if [[ -n "$(git -C "$TARGET_DIR" status --porcelain)" ]]; then
    printf 'get: working tree is dirty; skipping pull and reusing it as-is.\n' >&2
  else
    git -C "$TARGET_DIR" pull --ff-only || \
      printf 'get: fast-forward failed; continuing with the current checkout.\n' >&2
  fi
elif [[ -e "$TARGET_DIR" && -n "$(ls -A "$TARGET_DIR" 2>/dev/null)" ]]; then
  fail "$TARGET_DIR exists and is not a JobCtrl clone; pass --dir <path> or move it"
else
  printf '==> Cloning %s into %s\n' "$REPO_URL" "$TARGET_DIR"
  git clone "$REPO_URL" "$TARGET_DIR"
fi

[[ -x "$TARGET_DIR/scripts/install" ]] || fail "clone at $TARGET_DIR has no scripts/install"

if [[ "$ASSUME_YES" -eq 1 ]]; then
  INSTALL_ARGS+=(--yes)
fi

# macOS ships bash 3.2, where "${arr[@]}" on an empty array (and empty "$@")
# is an unbound-variable error under `set -u`; expand via the ${arr[@]+...}
# guard everywhere the array can be empty.
if [[ -t 0 ]]; then
  exec "$TARGET_DIR/scripts/install" ${INSTALL_ARGS[@]+"${INSTALL_ARGS[@]}"}
fi

# `curl | bash` leaves stdin on the pipe; reattach the terminal so the
# installer can prompt. `-r /dev/tty` is not enough — probe that it opens.
if [[ "$ASSUME_YES" -eq 0 ]] && (exec </dev/tty) 2>/dev/null; then
  exec "$TARGET_DIR/scripts/install" ${INSTALL_ARGS[@]+"${INSTALL_ARGS[@]}"} </dev/tty
fi

if [[ "$ASSUME_YES" -eq 0 ]]; then
  printf 'get: no interactive terminal; running installer with defaults (--yes).\n'
  INSTALL_ARGS+=(--yes)
fi
exec "$TARGET_DIR/scripts/install" ${INSTALL_ARGS[@]+"${INSTALL_ARGS[@]}"}
