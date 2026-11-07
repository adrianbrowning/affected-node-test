#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
demo_root=$(mktemp -d)
trap 'rm -rf "$demo_root"' EXIT HUP INT TERM
cp -R "$project_root/example/." "$demo_root"
cd "$demo_root"
git init
git config user.email demo@example.invalid
git config user.name Demo
git add .
git commit -m initial
node "$project_root/bin/affected-node-test.ts" baseline
printf '\n// modified\n' >> src/math.mjs
node "$project_root/bin/affected-node-test.ts" affected HEAD
