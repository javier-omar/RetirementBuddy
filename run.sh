#!/usr/bin/env bash
# RetirementBuddy — a fully local, browser-only app (no backend).
# This starts the dev server; your data lives in your browser and never leaves
# this machine. To make a shareable build, run: (cd frontend && npm run build)
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"

cd "$ROOT/frontend"
if [ ! -d node_modules ]; then
  echo "Installing dependencies…"
  npm install
fi

LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
echo
echo "  RetirementBuddy is starting."
echo "  → On this computer:   http://localhost:5173"
if [ -n "$LAN_IP" ]; then
  echo "  → On another device:  http://$LAN_IP:5173  (same Wi-Fi/LAN)"
fi
echo "  Press Ctrl+C to stop."
echo
npm run dev
