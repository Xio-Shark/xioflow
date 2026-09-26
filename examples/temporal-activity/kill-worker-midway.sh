#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

echo "================================================================"
echo "Temporal Worker Midway Crash & Recovery Drill"
echo "================================================================"

# Clean previous test state
rm -f effects.log
rm -rf .xioflow-kernel

# Run the activity retry drill
node simulate-activity-retry.mjs

echo ""
echo "Final effects.log content:"
cat effects.log
echo "Total lines in effects.log: $(wc -l < effects.log | tr -d ' ')"
