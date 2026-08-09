#!/usr/bin/env bash
# Deploy the worker to the exe.dev VM: pull latest main, install, restart.
set -euo pipefail
SSH="ssh -i $HOME/.ssh/pedro_exe_dev -o IdentitiesOnly=yes stagestackdev.exe.xyz"
$SSH 'cd /home/exedev/stagestack/app && git pull --ff-only && npm ci --no-audit --no-fund && sudo systemctl restart stagestack-worker && sleep 3 && systemctl is-active stagestack-worker && journalctl -u stagestack-worker -n 3 --no-pager'
