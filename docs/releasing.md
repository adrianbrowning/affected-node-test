# Releasing

`@gcmdev/affected-node-test` is a public MIT-licensed npm package. Releases follow [Semantic Versioning](https://semver.org/). While the package is below 1.0, incompatible CLI or configuration changes increment the minor version; compatible features increment the minor version; fixes increment the patch version.

## Publishing policy

- Publish only from `.github/workflows/release.yml` on a GitHub-hosted runner. A published GitHub Release is the human approval boundary, and the protected `npm` environment may require an additional maintainer approval.
- The GitHub Release tag must exactly equal `v` plus the version in `package.json`. Never reuse or move a published version tag.
- The workflow reruns the complete Node 26 gate, publishes publicly to npm, and requests an npm provenance attestation. The repository URL in `package.json` must continue to match this public GitHub repository.
- Prefer npm trusted publishing over a long-lived token. A package page must exist before its trusted publisher can be configured, so the bootstrap release uses a short-lived granular `NPM_TOKEN` with publish access in the `npm` GitHub environment. The workflow still produces provenance from GitHub Actions.
- After the bootstrap release, configure the npm trusted publisher for GitHub owner `adrianbrowning`, repository `affected-node-test`, workflow `release.yml`, environment `npm`, with direct-publish permission. Create this configuration only when the next release is ready because npm requires its first successful trusted publish within two days. The npm CLI checks OIDC before falling back to `NPM_TOKEN`; after that trusted publish succeeds, delete the GitHub secret and registry token, then require two-factor authentication while disallowing traditional tokens.
- Only maintainers with release authority for the `@gcmdev` npm scope may create the GitHub Release or approve the `npm` environment.

The trusted-publisher and provenance requirements follow the current [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) and [npm provenance](https://docs.npmjs.com/generating-provenance-statements/) guidance.

## Release procedure

1. Start from a clean `main` checkout whose required **Full suite gate** passed.
2. Choose the version under the policy above. Update `package.json` with `pnpm version <version> --no-git-tag-version`, and move the relevant `CHANGELOG.md` entries from **Unreleased** into a dated version section.
3. Run `pnpm install --lockfile-only`, `pnpm run check:full`, `pnpm review:performance`, and `npm pack --dry-run --json --ignore-scripts`. Confirm the tarball contains only `package.json`, `README.md`, `LICENSE`, `CHANGELOG.md`, `dist/**`, and `schema/**`.
4. Merge the release preparation commit to `main`; do not publish from an unmerged branch.
5. Create a GitHub Release from tag `v<version>`, using the changelog section as its notes. Publishing the GitHub Release starts the npm workflow.
6. Confirm the workflow completed, then verify `npm view @gcmdev/affected-node-test@<version>`, install it in a new empty directory, and confirm npm displays provenance linked to this repository and workflow.

The first public release is `0.1.0`. Before publishing it, confirm the `@gcmdev/affected-node-test` name is still unused and that the publishing maintainer belongs to the `@gcmdev` npm scope.

## Rollback and deprecation

npm versions are immutable. Never overwrite a release or move its tag.

- For an ordinary defect, immediately open an incident issue, document the impact, and publish a fixed patch. Deprecate only the affected version with `npm deprecate @gcmdev/affected-node-test@<version> "Use <fixed-version>: <reason>"`.
- For a severe supply-chain or user-harm incident, deprecate the affected range first, remove its `latest` dist-tag if necessary, and follow npm's unpublish policy only when its strict eligibility rules apply. Publish a clean replacement version; do not silently reuse the compromised number.
- If the CLI or package is retired, deprecate the entire package with a migration message and leave the repository, changelog, release tags, and security history available.
- Record every rollback, deprecation, or unpublish decision in a GitHub issue and the next changelog entry.
