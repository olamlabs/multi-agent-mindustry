#!/bin/sh

set -eu
TASK_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
TEST_RUN=$(mktemp -d)
trap 'test -z "${SERVER_PID:-}" || kill "$SERVER_PID" 2>/dev/null || true; rm -rf "$TEST_RUN"' EXIT
mkdir -p "$TEST_RUN/fixture" "$TEST_RUN/results"
sh "$TASK_DIR/environment/plugin/build.sh" /opt/mindustry/server.jar "$TEST_RUN/harbor.jar"
javac --release 17 -cp "/opt/mindustry/server.jar:$TEST_RUN/harbor.jar" -d "$TEST_RUN/fixture" "$TASK_DIR/solution/tests/native/SurvivalSmoke.java"
printf '%s\n' '{"name":"harbor-survival-smoke","main":"harbor.SurvivalSmoke","version":"1","minGameVersion":"160"}' > "$TEST_RUN/fixture/plugin.json"
jar uf "$TEST_RUN/harbor.jar" -C "$TEST_RUN/fixture" .
CASES=${SURVIVAL_CASES:-schedule-a schedule-b schedule-c long-small long-fractional economy-death stop modes budget clearance}
for CASE in $CASES; do
    RUN="$TEST_RUN/$CASE"
    mkdir -p "$RUN/config/mods"
    cp "$TEST_RUN/harbor.jar" "$RUN/config/mods/harbor.jar"
    (cd "$RUN" && MINDUSTRY_EVIDENCE_DIR="$RUN/evidence" exec java -jar /opt/mindustry/server.jar >server.log 2>&1) &
    SERVER_PID=$!
    for attempt in $(seq 1 240); do
        if curl -fsS -X POST -d '{}' http://127.0.0.1:8091/health >/dev/null 2>&1; then break; fi
        kill -0 "$SERVER_PID" 2>/dev/null || { cat "$RUN/server.log"; exit 1; }
        sleep .25
    done
    python3 "$TASK_DIR/solution/tests/native/survival.py" "$CASE" "$RUN/evidence" "$TEST_RUN/results" || { tail -50 "$RUN/server.log"; exit 1; }
    kill "$SERVER_PID"; wait "$SERVER_PID" 2>/dev/null || true; SERVER_PID=
done
test -n "${SURVIVAL_CASES:-}" || python3 "$TASK_DIR/solution/tests/native/survival.py" compare "$TEST_RUN/results"
if test -n "${SURVIVAL_EVIDENCE_DIR:-}"; then
    mkdir -p "$SURVIVAL_EVIDENCE_DIR"
    for CASE in $CASES; do mkdir -p "$SURVIVAL_EVIDENCE_DIR/$CASE"; cp -R "$TEST_RUN/$CASE/evidence/." "$SURVIVAL_EVIDENCE_DIR/$CASE/"; done
    cp -R "$TEST_RUN/results" "$SURVIVAL_EVIDENCE_DIR/results"
fi
