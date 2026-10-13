#!/usr/bin/env bash
set -euo pipefail

status_output="$(SUPABASE_TELEMETRY_DISABLED=1 supabase status -o env)"
get_status_value() {
  local key="$1"
  printf '%s\n' "$status_output" | awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); gsub(/^"|"$/, ""); print; exit }'
}

export SUPABASE_URL="$(get_status_value API_URL)"
export SUPABASE_ANON_KEY="$(get_status_value ANON_KEY)"
export SUPABASE_SERVICE_ROLE_KEY="$(get_status_value SERVICE_ROLE_KEY)"
project_id="$(sed -n 's/^project_id = "\([^"]*\)"/\1/p' supabase/config.toml | head -n 1)"
export SUPABASE_DB_CONTAINER="$(docker ps --filter "name=supabase_db_${project_id}" --format '{{.Names}}' | head -n 1)"
export VITE_SUPABASE_URL="$SUPABASE_URL"
export VITE_SUPABASE_PUBLISHABLE_KEY="$(get_status_value PUBLISHABLE_KEY)"
export RUN_PROGRESS_TRACKER_LOCAL_INTEGRATION=true

if [[ -z "$SUPABASE_URL" || -z "$SUPABASE_ANON_KEY" || -z "$SUPABASE_SERVICE_ROLE_KEY" || -z "$VITE_SUPABASE_PUBLISHABLE_KEY" || -z "$SUPABASE_DB_CONTAINER" ]]; then
  echo "Local Supabase is not running or its local API keys are unavailable." >&2
  exit 1
fi

npx vitest run src/services/supabase/progressionLive.integration.test.ts --reporter=verbose
