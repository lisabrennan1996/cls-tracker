#!/usr/bin/env bash
# build-cf.sh — used by Cloudflare Pages (no sudo, HOME is writable)
set -euo pipefail

# Rust
curl https://sh.rustup.rs -sSf | sh -s -- -y --default-toolchain stable
source "$HOME/.cargo/env"
rustup target add wasm32-unknown-unknown

# wasm-pack
curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh

# Build
cd wasm
wasm-pack build \
  --target web \
  --out-dir ../public/pkg \
  --out-name liteparse_wasm \
  --release
