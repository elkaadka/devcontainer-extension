#!/usr/bin/env bash
# End-to-end test: build -> check tools -> recreate -> check persistence -> second project (hybrid check).
# Needs docker and @devcontainers/cli (see Dockerfile.cli / run-e2e.ps1). Takes several minutes.
#
# Environment:
#   E2E_NPM_REGISTRY, E2E_PIP_INDEX_URL, E2E_PIP_TRUSTED_HOST  package sources for the generated containers
#   E2E_WORK       work folder as seen by this script        (default: <repo>/e2e/work)
#   E2E_HOST_WORK  the same folder as seen by the Docker daemon (default: $E2E_WORK)
#   E2E_PACKAGES   comma-separated package ids             (default: node,typescript,python,azure-cli,azd,copilot,copilot-cli)
#   E2E_KEEP=1     keep containers and volumes for inspection
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${E2E_WORK:-$REPO/e2e/work}"
HOST_WORK="${E2E_HOST_WORK:-$WORK}"
PACKAGES="${E2E_PACKAGES:-node,typescript,python,azure-cli,azd,copilot,copilot-cli}"
RUN_ID="$(date +%s)"
SHARED_VOLUME="devc-e2e-shared-$RUN_ID"
LABEL="devcontainer-composer-e2e=$RUN_ID"
PASS=0
FAIL=0

log() { printf '\n\033[1;34m== %s\033[0m\n' "$*"; }
ok() { printf '  \033[32mPASS\033[0m %s\n' "$*"; PASS=$((PASS + 1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAIL=$((FAIL + 1)); }
check() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$name"; else bad "$name"; fi; }

cleanup() {
  if [ "${E2E_KEEP:-0}" = "1" ]; then
    log "E2E_KEEP=1: keeping containers (label $LABEL) and volumes"
    return
  fi
  log "Cleaning up"
  local ids volumes
  ids="$(docker ps -aq --filter "label=$LABEL" || true)"
  volumes="$SHARED_VOLUME"
  for id in $ids; do
    volumes="$volumes $(docker inspect -f '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}} {{end}}{{end}}' "$id" | tr ' ' '\n' | grep '^devc-' | grep -- '-project$' || true)"
  done
  [ -n "$ids" ] && docker rm -f $ids >/dev/null
  for v in $(echo "$volumes" | tr ' ' '\n' | sort -u); do
    docker volume rm "$v" >/dev/null 2>&1 && echo "  removed volume $v" || true
  done
}
trap cleanup EXIT

dc_exec() { local dir="$1"; shift; devcontainer exec --workspace-folder "$dir" --id-label "$LABEL" --id-label "e2e-project=$(basename "$dir")" bash -lc "$*"; }
dc_up() {
  local dir="$1"; shift
  devcontainer up --workspace-folder "$dir" --id-label "$LABEL" --id-label "e2e-project=$(basename "$dir")" "$@" \
    > "$WORK/$(basename "$dir").up.log" 2>&1 || { tail -n 60 "$WORK/$(basename "$dir").up.log"; return 1; }
}

log "Compiling the generator"
cd "$REPO"
[ -d node_modules/jsonc-parser ] || npm ci --no-audit --no-fund
npx tsc -p tsconfig.test.json

rm -rf "$WORK"
mkdir -p "$WORK/project-a" "$WORK/project-b"
for p in project-a project-b; do
  node e2e/generate.js --dir "$WORK/$p" --packages "$PACKAGES" --shared-volume "$SHARED_VOLUME" \
    --npm "${E2E_NPM_REGISTRY:-}" --pip "${E2E_PIP_INDEX_URL:-}" --pip-host "${E2E_PIP_TRUSTED_HOST:-}" \
    --host-path "$HOST_WORK/$p"
done
A="$WORK/project-a"
B="$WORK/project-b"

log "Building and starting project A (several minutes on first run)"
dc_up "$A"
ok "project A container is up"

log "Tools"
has() { case ",$PACKAGES," in *",$1,"*) return 0 ;; *) return 1 ;; esac; }
has node && check "node" dc_exec "$A" 'node --version'
has typescript && check "tsc" dc_exec "$A" 'tsc --version'
has python && check "python" dc_exec "$A" 'python3 --version'
has azure-cli && check "az" dc_exec "$A" 'az version'
has azd && check "azd" dc_exec "$A" 'azd version'
has copilot-cli && check "copilot cli" dc_exec "$A" 'command -v copilot'

log "Persistence setup"
check "volumes owned by remote user" dc_exec "$A" '[ "$(stat -c %U /persist/shared)" = "$(id -un)" ] && [ "$(stat -c %U /persist/project)" = "$(id -un)" ]'
check "HISTFILE points to project volume" dc_exec "$A" '[ "$(bash -ic "echo \$HISTFILE" 2>/dev/null)" = /persist/project/shell-history/bash_history ]'
has azure-cli && check "~/.azure -> shared volume" dc_exec "$A" '[ "$(readlink ~/.azure)" = /persist/shared/azure ]'
has copilot-cli && check "~/.copilot -> project volume" dc_exec "$A" '[ "$(readlink ~/.copilot)" = /persist/project/copilot-cli ]'

dc_exec "$A" 'echo "echo e2e-history" >> /persist/project/shell-history/bash_history'
has azure-cli && dc_exec "$A" 'echo shared > ~/.azure/e2e-marker'
has copilot-cli && dc_exec "$A" 'echo project > ~/.copilot/e2e-marker'
has copilot && dc_exec "$A" 'mkdir -p ~/.vscode-server/data/User/globalStorage/e2e && echo copilot > ~/.vscode-server/data/User/globalStorage/e2e/state'

log "Recreating project A (simulates Rebuild Container)"
dc_up "$A" --remove-existing-container
check "shell history survives" dc_exec "$A" 'grep -q e2e-history "$(bash -ic "echo \$HISTFILE" 2>/dev/null)"'
has azure-cli && check "Azure login survives" dc_exec "$A" 'grep -q shared ~/.azure/e2e-marker'
has copilot-cli && check "Copilot CLI state survives" dc_exec "$A" 'grep -q project ~/.copilot/e2e-marker'
has copilot && check "VS Code / Copilot global state survives" dc_exec "$A" 'grep -q copilot ~/.vscode-server/data/User/globalStorage/e2e/state'

log "Project B (same shared volume, own project volume)"
dc_up "$B"
check "shell history is isolated" dc_exec "$B" '! grep -qs e2e-history /persist/project/shell-history/bash_history'
has azure-cli && check "logins are shared between projects" dc_exec "$B" 'grep -q shared ~/.azure/e2e-marker'
has copilot-cli && check "project state is isolated" dc_exec "$B" '[ ! -e ~/.copilot/e2e-marker ]'
dc_exec "$B" 'echo b-only > /persist/shared/e2e-from-b' && check "shared volume is the same in A" dc_exec "$A" 'grep -q b-only /persist/shared/e2e-from-b'

log "Result: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
