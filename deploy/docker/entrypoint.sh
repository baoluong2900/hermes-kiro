#!/bin/bash
set -euo pipefail

if [[ -z "${TUNNEL_TOKEN:-}" ]]; then
    exec "$@"
fi

pids=()
cleanup() {
    trap '' TERM INT
    kill -TERM "${pids[@]}" 2>/dev/null || true
    wait "${pids[@]}" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

"$@" &
pids+=("$!")
# Use TCP/7844 instead of depending on outbound QUIC/UDP support.
cloudflared tunnel --no-autoupdate --protocol http2 --metrics 127.0.0.1:20241 run &
pids+=("$!")

status=0
wait -n "${pids[@]}" || status=$?
exit "$status"
