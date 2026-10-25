#!/bin/sh
set -eu
TASK_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
TEST_RUN=$(mktemp -d)
trap 'test -z "${SERVER_PID:-}" || kill "$SERVER_PID" 2>/dev/null || true; rm -rf "$TEST_RUN"' EXIT
mkdir -p "$TEST_RUN/config/mods"
sh "$TASK_DIR/environment/plugin/build.sh" /opt/mindustry/server.jar "$TEST_RUN/config/mods/harbor.jar"

if test -f "$TASK_DIR/solution/tests/native/SmokeBridge.java"; then
    mkdir -p "$TEST_RUN/fixture"
    javac --release 17 -cp "/opt/mindustry/server.jar:$TEST_RUN/config/mods/harbor.jar" -d "$TEST_RUN/fixture" "$TASK_DIR/solution/tests/native/SmokeBridge.java"
    printf '%s\n' '{"name":"harbor-smoke","main":"harbor.SmokeBridge","version":"1","minGameVersion":"160"}' > "$TEST_RUN/fixture/plugin.json"
    jar uf "$TEST_RUN/config/mods/harbor.jar" -C "$TEST_RUN/fixture" .
fi
cd "$TEST_RUN"
MINDUSTRY_EVIDENCE_DIR="$TEST_RUN/evidence" java -jar /opt/mindustry/server.jar > server.log 2>&1 &
SERVER_PID=$!
for attempt in $(seq 1 120); do
    if python3 -c 'import urllib.request; urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:8091/health",data=b"{}"),timeout=1).read()' >/dev/null 2>&1; then break; fi
    kill -0 "$SERVER_PID" 2>/dev/null || { cat server.log; exit 1; }
    sleep .25
done
python3 "$TASK_DIR/solution/tests/native/smoke.py" "$@" --evidence "$TEST_RUN/evidence" || { cat server.log; exit 1; }
