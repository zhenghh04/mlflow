#!/usr/bin/env bash
# Start a local MLflow multi-tenant server for testing.
# Usage: ./start-multi-tenant.sh [port]
set -euo pipefail

PORT=${1:-5005}
WORKDIR=/tmp/mlflow-mt-test
PROJECT="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$WORKDIR/artifacts"

# Write config if it doesn't exist
if [[ ! -f "$WORKDIR/basic_auth.ini" ]]; then
cat > "$WORKDIR/basic_auth.ini" <<INI
[mlflow]
default_permission = READ
database_uri = sqlite:///$WORKDIR/auth.db
admin_username = admin
admin_password = admin1234567
authorization_function = mlflow.server.auth:authenticate_request_basic_auth
grant_default_workspace_access = false
INI
fi

echo "Starting MLflow multi-tenant server on http://127.0.0.1:$PORT"
echo "  Admin credentials: admin / admin1234567"
echo "  Tracking DB:       $WORKDIR/tracking.db"
echo "  Auth DB:           $WORKDIR/auth.db"
echo "  Artifacts:         $WORKDIR/artifacts"
echo "  Logs:              $WORKDIR/server.log"
echo ""
echo "Tenant header:  X-MLflow-Tenant: <slug>"
echo "Tenant API:     POST $PORT/api/3.0/mlflow/tenants/create"
echo ""

PYTHONPATH="$PROJECT" \
  MLFLOW_AUTH_CONFIG_PATH="$WORKDIR/basic_auth.ini" \
  MLFLOW_FLASK_SERVER_SECRET_KEY="dev-secret-key-multi-tenant" \
  python3 -m mlflow server \
    --host 127.0.0.1 \
    --port "$PORT" \
    --app-name basic-auth \
    --backend-store-uri "sqlite:///$WORKDIR/tracking.db" \
    --artifacts-destination "$WORKDIR/artifacts" \
    --serve-artifacts
# Note: use --allowed-hosts '*' when running behind a reverse proxy
# (nginx/caddy) to allow any Host header. Without it MLflow's security
# middleware rejects requests where Host != localhost.
