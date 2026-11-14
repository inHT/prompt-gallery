#!/bin/sh
cd "$(dirname "$0")"
export PYTHONIOENCODING=utf-8
exec python3 server.py --host "${HOST:-127.0.0.1}" --port "${PORT:-8765}"
