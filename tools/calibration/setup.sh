#!/bin/sh
# Installs the offline-only measurement tools into tools/calibration/.vendor (gitignored):
#   Stockfish 19 (GPL-3.0, official release binary) and chess.js 1.4.0 (BSD-2-Clause).
# Neither is shipped with the game. On Linux, set STOCKFISH=/path/to/stockfish instead.
set -e
cd "$(dirname "$0")"
mkdir -p .vendor && cd .vendor
if [ ! -x stockfish/stockfish-macos-universal ] && [ -z "$STOCKFISH" ]; then
    curl -sL -o sf.tgz https://github.com/official-stockfish/Stockfish/releases/download/sf_19/stockfish-macos-universal.tar.gz
    echo "a1f0e3bcc5a6927a11fe6fc8e54a779754645f3c2bae2cf13420fd1957adaa77  sf.tgz" | shasum -a 256 -c -
    tar xzf sf.tgz
    xattr -d com.apple.quarantine stockfish/stockfish-macos-universal 2>/dev/null || true
fi
[ -f package.json ] || echo '{"name":"calibration-vendor","private":true}' > package.json
npm install --no-audit --no-fund chess.js@1.4.0

# Optional human anchor: lc0 + Maia (GPL-3.0). Put an lc0 binary (e.g. extracted from the Homebrew
# bottle lc0 0.32.1) at .vendor/lc0/lc0, or set LC0=/path/to/lc0. Weights from the Maia release.
mkdir -p lc0
for r in 1100 1500 1900; do
    [ -f lc0/maia-$r.pb.gz ] || curl -sL -o lc0/maia-$r.pb.gz https://github.com/CSSLab/maia-chess/releases/download/v1.0/maia-$r.pb.gz
done
[ -x lc0/lc0 ] || [ -n "$LC0" ] || echo "note: no lc0 binary; maia:* players will not work (see setup.sh)"
