# TypeScript development and migration

The repository requires Node 26 and runs its development `.ts` files directly with Node's native type stripping. No loader or transformer belongs in the development test command.

Keep source syntax erasable at runtime: use types and type-only imports, and avoid TypeScript features that emit JavaScript, including enums and parameter properties. `tsconfig.json` enforces this boundary with `erasableSyntaxOnly`, `verbatimModuleSyntax`, and strict checking.

The development workflow is:

```sh
pnpm typecheck
pnpm test
pnpm build
```

`pnpm build` rewrites local `.ts` import extensions and emits executable JavaScript under `dist/`. The npm package includes `dist/`, the schema, and the README; it excludes TypeScript source and tests. Always exercise the emitted CLI and inspect the packed file list when changing build or package metadata. `pnpm run check:full` performs the complete documentation, typecheck, build, package, and integration-test gate.

When migrating another file, rename it to `.ts`, update local development imports to explicit `.ts` paths, add narrow types at I/O boundaries, and validate parsed JSON before relying on its shape. Do not weaken the strict project or exclude migrated tests to make the check pass.
