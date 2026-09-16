#!/bin/sh
set -eu
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then sh ./bootstrap.sh; fi
exec .venv/bin/python -m uvicorn server.server:app --host 0.0.0.0 --port "${PORT:-8321}"
