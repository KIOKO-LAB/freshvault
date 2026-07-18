#!/bin/bash
# Prepares a clean demo dir and records docs/demo.gif with VHS.
# Usage: bash demo/record.sh [demo-workdir]
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
DEMO="${1:-/tmp/fv-demo}"

rm -rf "$DEMO"
mkdir -p "$DEMO/vault" "$DEMO/data"
cd "$DEMO"

# seed notes so search results have neighbors
cat > "vault/Reading List.md" <<'EOF'
# Reading List
Books to read this year: Thinking Fast and Slow, The Design of Everyday Things, Snow Crash.
EOF
cat > "vault/Trip Planning.md" <<'EOF'
# Trip Planning
Hokkaido winter trip: Sapporo snow festival, an onsen day in Noboribetsu, seafood market morning.
EOF

# env the tape shell will source
cat > env.sh <<EOF
export FRESHVAULT_VAULT="$DEMO/vault"
export FRESHVAULT_DATA="$DEMO/data"
export FRESHVAULT_BIN="$REPO/bin/freshvault.mjs"
EOF

cp "$REPO/demo/ask.mjs" ask.mjs
cp "$REPO/demo/demo.tape" demo.tape

export FRESHVAULT_VAULT="$DEMO/vault"
export FRESHVAULT_DATA="$DEMO/data"

echo "== pre-indexing seed notes =="
node "$REPO/bin/freshvault.mjs" index

echo "== starting writer server (watcher inside) =="
# tail -f /dev/null keeps stdin open — the server exits on stdin EOF by design
tail -f /dev/null | node "$REPO/bin/freshvault.mjs" serve 2> server.log &
SERVER_PID=$!
sleep 2
grep -q "writer mode" server.log || { echo "server did not become writer"; cat server.log; exit 1; }

echo "== recording (this takes ~30s realtime) =="
vhs demo.tape

kill "$SERVER_PID" 2>/dev/null || true
mkdir -p "$REPO/docs"
mv demo.gif "$REPO/docs/demo.gif"
echo "== done: $REPO/docs/demo.gif =="
ls -lh "$REPO/docs/demo.gif"
