#!/bin/sh
# Builds whisper.cpp's server (one self-contained binary, Metal built in) into build/bin for local
# Whisper transcription. Skipped when it is there; WHISPER_VERSION picks the release.
set -eu
cd "$(dirname "$0")/.."
VERSION="${WHISPER_VERSION:-1.9.5}"
OUT=build/bin/whisper-server
if [ -x "$OUT" ] && [ -f "build/bin/.whisper-$VERSION" ]; then exit 0; fi
SRC="build/whisper.cpp-$VERSION"
if [ ! -d "$SRC" ]; then
  mkdir -p build
  curl -sL "https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v$VERSION.tar.gz" | tar xz -C build
fi
# Source paths baked into asserts would carry this machine's folders into a published app.
MAP="-ffile-prefix-map=$(pwd)/$SRC=whisper.cpp"
cmake -S "$SRC" -B "$SRC/out" -DCMAKE_BUILD_TYPE=Release -DCMAKE_C_FLAGS="$MAP" -DCMAKE_CXX_FLAGS="$MAP" -DBUILD_SHARED_LIBS=OFF -DGGML_METAL=ON \
  -DGGML_METAL_EMBED_LIBRARY=ON -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=ON -DGGML_NATIVE=OFF \
  -DCMAKE_OSX_DEPLOYMENT_TARGET=13.0 >/dev/null
cmake --build "$SRC/out" --target whisper-server -j 8 >/dev/null
mkdir -p build/bin
cp "$SRC/out/bin/whisper-server" "$OUT"
rm -f build/bin/.whisper-*
touch "build/bin/.whisper-$VERSION"
echo "Built $OUT (whisper.cpp $VERSION)"
