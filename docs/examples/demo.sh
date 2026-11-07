cd example
git init
git add .
git commit -m initial
node ../bin/affected-node-test.ts baseline
printf '\n// modified\n' >> src/math.mjs
node ../bin/affected-node-test.ts affected HEAD
