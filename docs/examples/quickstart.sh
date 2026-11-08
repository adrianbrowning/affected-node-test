pnpm add --save-dev @gcmdev/affected-node-test
pnpm exec affected-node-test baseline

# After changing source or tests, run the affected feedback loop.
pnpm exec affected-node-test affected

# Always finish with the project's complete test command.
node --test
