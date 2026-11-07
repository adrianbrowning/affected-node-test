pnpm exec affected-node-test baseline --concurrency 4
pnpm exec affected-node-test affected --concurrency 4
pnpm exec affected-node-test affected --concurrency 50%
pnpm exec affected-node-test affected origin/main --concurrency 4
pnpm exec affected-node-test related src/math.mjs --concurrency 4
pnpm exec affected-node-test since-last-run --concurrency 4
pnpm exec affected-node-test last-failed --concurrency 4
pnpm exec affected-node-test watch --concurrency 4
pnpm exec affected-node-test clear-cache
pnpm exec affected-node-test doctor
pnpm exec affected-node-test affected --output=json
pnpm exec affected-node-test affected --dry-run --output=json
