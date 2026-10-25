#!/bin/sh
set -eu
PLUGIN_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SERVER_JAR=${1:-/opt/mindustry/server.jar}
OUTPUT=${2:-$PLUGIN_DIR/harbor-bridge.jar}
BUILD_DIR=$(mktemp -d)
trap 'rm -rf "$BUILD_DIR"' EXIT
javac --release 17 -cp "$SERVER_JAR" -d "$BUILD_DIR" "$PLUGIN_DIR"/src/harbor/*.java
cp "$PLUGIN_DIR/plugin.json" "$BUILD_DIR/plugin.json"
cp -R "$PLUGIN_DIR/resources/." "$BUILD_DIR/"

LICENSE_DIR="$PLUGIN_DIR/../.."
if [ ! -f "$LICENSE_DIR/LICENSE" ]; then LICENSE_DIR=/opt/licenses; fi
cp "$LICENSE_DIR/LICENSE" "$LICENSE_DIR/NOTICE.md" "$BUILD_DIR/"
jar cf "$OUTPUT" -C "$BUILD_DIR" .
