# TypeScript development and migration

The repository requires Node 26 and runs its development `.ts` files directly with Node's native type stripping. No loader or transformer belongs in the development test command.

Keep source syntax erasable at runtime: use types and type-only imports, and avoid TypeScript features that emit JavaScript, including enums and parameter properties. `tsconfig.json` extends `@gingacodemonkey/config/tsc/no-dom/library` and enforces this boundary with `erasableSyntaxOnly`, `verbatimModuleSyntax`, and strict checking. This project currently keeps `noUncheckedIndexedAccess` and `noImplicitReturns` at their previous settings while existing source is migrated to those additional checks.

The development workflow is:

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

`pnpm build` rewrites local `.ts` import extensions and emits executable JavaScript under `dist/`. `tsconfig.build.json` disables the shared preset's declaration and source-map output to preserve the existing package artifact. ESLint uses the shared logic config with explicit overrides for this repository's CLI, test, and deterministic path-handling conventions. The npm package includes `dist/`, the schema, and the README; it excludes TypeScript source and tests. Always exercise the emitted CLI and inspect the packed file list when changing build or package metadata. `pnpm run check:full` performs the complete documentation, typecheck, lint, build, package, and integration-test gate.

When migrating another file, rename it to `.ts`, update local development imports to explicit `.ts` paths, add narrow types at I/O boundaries, and validate parsed JSON before relying on its shape. Do not weaken the strict project or exclude migrated tests to make the check pass.
