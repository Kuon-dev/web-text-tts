#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -f .venv/.deps-installed ]; then
  echo "First run: creating venv and installing deps (several GB, be patient)..."
  python3 -m venv .venv
  .venv/bin/pip install -r requirements.txt
  touch .venv/.deps-installed
fi
exec .venv/bin/python server.py
