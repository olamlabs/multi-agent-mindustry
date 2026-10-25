#!/bin/sh

set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "${HARBOR_PYTHON:-python3}" "$HERE/integration.py" "$@"
