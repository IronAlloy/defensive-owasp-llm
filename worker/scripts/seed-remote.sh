#!/usr/bin/env bash
# Seeds the remote D1 via the query API (--command), avoiding the /import endpoint.
# Run from the worker folder:  bash scripts/seed-remote.sh
set -euo pipefail
cd "$(dirname "$0")/.."
for f in seed-chunks/*.sql; do
  echo "==> $f"
  npx wrangler d1 execute vr_db --remote --yes --command "$(cat "$f")" > /dev/null
done
echo "Done. Verifying:"
npx wrangler d1 execute vr_db --remote --command "SELECT (SELECT COUNT(*) FROM customers) customers, (SELECT COUNT(*) FROM orders) orders, (SELECT COUNT(*) FROM kb) kb"
