#!/usr/bin/env bash
# Deploy the worker to the always-on VM: pull latest main, install, restart.
#
# The SSH target is configuration, not code: a self-hoster's VM is not
# stagestackdev.exe.xyz and their key is not the maintainer's. Both come from
# the environment, and the script refuses to guess.
#
#   WORKER_SSH_HOST      user@host (or an ssh_config alias) of the worker VM
#   WORKER_SSH_IDENTITY  optional path to the private key; omit to use the
#                        agent / ssh_config defaults
#   WORKER_APP_DIR       optional checkout path on the VM (default below)
#   WORKER_SERVICE       optional systemd unit name (default below)
set -euo pipefail

if [ -z "${WORKER_SSH_HOST:-}" ]; then
  echo "error: WORKER_SSH_HOST is not set (e.g. WORKER_SSH_HOST=deploy@worker.example.com $0)" >&2
  exit 2
fi

APP_DIR="${WORKER_APP_DIR:-/home/exedev/stagestack/app}"
SERVICE="${WORKER_SERVICE:-stagestack-worker}"

ssh_args=()
if [ -n "${WORKER_SSH_IDENTITY:-}" ]; then
  if [ ! -f "$WORKER_SSH_IDENTITY" ]; then
    echo "error: WORKER_SSH_IDENTITY=$WORKER_SSH_IDENTITY does not exist" >&2
    exit 2
  fi
  # IdentitiesOnly stops ssh from offering every key in the agent first.
  ssh_args+=(-i "$WORKER_SSH_IDENTITY" -o IdentitiesOnly=yes)
fi

ssh "${ssh_args[@]}" "$WORKER_SSH_HOST" "cd '$APP_DIR' && git pull --ff-only && npm ci --no-audit --no-fund && sudo systemctl restart '$SERVICE' && sleep 3 && systemctl is-active '$SERVICE' && journalctl -u '$SERVICE' -n 3 --no-pager"
