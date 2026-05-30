#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/native/photokit-helper/main.swift"
OUT="$ROOT/native/photokit-helper/photokit-helper"
CACHE="$ROOT/.build/module-cache"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "swiftc not found. Install Xcode Command Line Tools first: xcode-select --install" >&2
  exit 1
fi

mkdir -p "$CACHE"
export CLANG_MODULE_CACHE_PATH="$CACHE"

swiftc "$SRC" \
  -module-cache-path "$CACHE" \
  -framework Foundation \
  -framework Photos \
  -framework AppKit \
  -o "$OUT"
chmod +x "$OUT"
echo "Built $OUT"
