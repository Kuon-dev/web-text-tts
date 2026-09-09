#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
# Optional per-host config, never in the repo: NOVEL_TTS_IMAGE_TOKEN and
# NOVEL_TTS_IMAGE_TOKEN_HOSTS let the server fetch illustrations from a private
# image host (see README). Excluded from deploys so it survives an rsync.
if [ -f .env ]; then set -a; . ./.env; set +a; fi
if [ ! -f .venv/.deps-installed ]; then
  echo "First run: creating venv and installing deps (several GB, be patient)..."
  python3 -m venv .venv
  .venv/bin/pip install -r requirements.txt
  touch .venv/.deps-installed
fi
exec .venv/bin/python server.py
