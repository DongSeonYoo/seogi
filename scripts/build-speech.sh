#!/bin/sh
# Builds the on-device transcription helper (native/speech) into build/bin, when its source changed.
set -eu
cd "$(dirname "$0")/.."
OUT=build/bin/seogi-speech
SRC=native/speech/main.swift
if [ -x "$OUT" ] && [ "$OUT" -nt "$SRC" ]; then exit 0; fi
mkdir -p build/bin
xcrun swiftc -swift-version 5 -O -target arm64-apple-macos26.0 "$SRC" -o "$OUT"
echo "Built $OUT"
