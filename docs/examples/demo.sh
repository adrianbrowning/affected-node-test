cd example
git init
git add .
git commit -m initial
node ../bin/affected-node-test.mjs baseline
printf '\n// modified\n' >> src/math.mjs
node ../bin/affected-node-test.mjs affected HEAD
