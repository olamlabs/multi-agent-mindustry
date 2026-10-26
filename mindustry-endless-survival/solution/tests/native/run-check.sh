#!/bin/sh

set -eu
CHECK=${1:-api}
case "$CHECK" in
    api) CLASS=SmokeBridge; DRIVER=smoke.py ;;
    telemetry) CLASS=TelemetrySmoke; DRIVER=telemetry.py ;;
    evaluation) CLASS=EvaluationSmoke; DRIVER=evaluation.py ;;
    *) echo 'Usage: run-check.sh api|telemetry|evaluation [API test arguments]' >&2; exit 2 ;;
esac
if [ "$#" -gt 0 ]; then shift; fi
if [ "$CHECK" = api ] && [ "$#" -eq 0 ]; then set -- --seats 2; fi
TASK_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
TEST_RUN=$(mktemp -d)
trap 'test -z "${SERVER_PID:-}" || kill "$SERVER_PID" 2>/dev/null || true; rm -rf "$TEST_RUN"' EXIT
mkdir -p "$TEST_RUN/config/mods" "$TEST_RUN/fixture"
sh "$TASK_DIR/environment/plugin/build.sh" /opt/mindustry/server.jar "$TEST_RUN/config/mods/agent-bridge.jar"
javac --release 17 -cp "/opt/mindustry/server.jar:$TEST_RUN/config/mods/agent-bridge.jar" -d "$TEST_RUN/fixture" "$TASK_DIR/solution/tests/native/$CLASS.java"
printf '{"name":"agent-bridge-test","main":"agentbridge.%s","version":"1","minGameVersion":"160"}\n' "$CLASS" > "$TEST_RUN/fixture/plugin.json"
jar uf "$TEST_RUN/config/mods/agent-bridge.jar" -C "$TEST_RUN/fixture" .
cd "$TEST_RUN"
MINDUSTRY_EVIDENCE_DIR="$TEST_RUN/evidence" java -jar /opt/mindustry/server.jar >server.log 2>&1 &
SERVER_PID=$!
for attempt in $(seq 1 120); do
    if curl -fsS -X POST -d '{}' http://127.0.0.1:8091/health >/dev/null 2>&1; then break; fi
    kill -0 "$SERVER_PID" 2>/dev/null || { cat server.log; exit 1; }
    sleep .25
done
if [ "$CHECK" = api ]; then
    python3 "$TASK_DIR/solution/tests/native/$DRIVER" "$@" --evidence "$TEST_RUN/evidence" || { cat server.log; exit 1; }
else
    python3 "$TASK_DIR/solution/tests/native/$DRIVER" "$TEST_RUN/evidence" || { cat server.log; exit 1; }
fi
if [ -n "${NATIVE_EVIDENCE_DIR:-}" ]; then
    mkdir -p "$NATIVE_EVIDENCE_DIR"
    cp -R "$TEST_RUN/evidence/." "$NATIVE_EVIDENCE_DIR/"
fi
