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
cp "$PLUGIN_DIR/../../LICENSE" "$BUILD_DIR/LICENSE"
cp "$PLUGIN_DIR/../../NOTICE" "$BUILD_DIR/NOTICE"
jar cf "$OUTPUT" -C "$BUILD_DIR" .
