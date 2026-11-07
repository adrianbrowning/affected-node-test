node bin/affected-node-test.mjs baseline --concurrency 4
node bin/affected-node-test.mjs affected --concurrency 4
node bin/affected-node-test.mjs affected origin/main --concurrency 4
node bin/affected-node-test.mjs related src/math.mjs --concurrency 4
node bin/affected-node-test.mjs since-last-run --concurrency 4
node bin/affected-node-test.mjs clear-cache
