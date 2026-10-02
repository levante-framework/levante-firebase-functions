#!/bin/bash

set -euo pipefail

dir=$(cd "$(dirname "$0")" && pwd)

shopt -s nullglob
files=("$dir"/*.test.js)

if [ ${#files[@]} -eq 0 ]; then
  echo "No script tests found." >&2
  exit 1
fi

exec node --test "${files[@]}"
