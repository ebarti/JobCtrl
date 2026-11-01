#!/bin/sh
# Owned synthetic cross-stack regression. The workspace and logs are retained.
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
checkout=$(CDPATH= cd -- "$script_dir/../../.." && pwd)
task_python=${JOBCTRL_PROOF_PYTHON:?Set JOBCTRL_PROOF_PYTHON to the existing locked Python executable}
task_node=$(command -v node)
task_corepack=$(command -v corepack)
task_temporal=${JOBCTRL_TEMPORAL_CLI_PATH:-$(command -v temporal)}
task_lsof=$(command -v lsof)
task_corepack_home=${COREPACK_HOME:-"$HOME/.cache/node/corepack"}
task_root=$(mktemp -d "${TMPDIR:-/tmp}/jobctrl-profile-import-proof.XXXXXXXX")
mkdir -p "$task_root/home" "$task_root/tmp" "$task_root/workspace"
printf 'Owned synthetic proof root: %s\n' "$task_root"
env -i \
  PATH="$(dirname "$task_node"):/usr/bin:/bin:/usr/sbin:/sbin" \
  HOME="$task_root/home" TMPDIR="$task_root/tmp" JOBCTRL_DIR="$task_root/workspace" \
  TASK_PROOF_ROOT="$task_root" TASK_PROOF_SCRIPTS="$script_dir" TASK_CHECKOUT="$checkout" \
  TASK_PYTHON="$task_python" TASK_NODE="$task_node" TASK_COREPACK="$task_corepack" \
  TASK_TEMPORAL_CLI="$task_temporal" TASK_LSOF="$task_lsof" \
  COREPACK_HOME="$task_corepack_home" COREPACK_ENABLE_NETWORK=0 \
  JOBCTRL_PRODUCT_PATH_PROOF=1 NODE_OPTIONS=--max-old-space-size=2048 PYTHONNOUSERSITE=1 \
  PYTHONPATH="$checkout/workers/automation/src:$checkout/workers/automation" \
  "$task_python" "$script_dir/run.py"
