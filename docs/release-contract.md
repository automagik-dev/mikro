# RLMX Release Contract

RLMX follows the Hermes/Genie install/update shape:

- `scripts/install.sh` is the canonical installer.
- `rlmx update` updates an installed checkout by fetching the latest public `main` commits.
- npm is SDK-only distribution. npm is not the canonical end-user CLI release channel.
- The canonical release boundary is a PR merge from `dev` to `main`.

## Channels

### CLI / application channel

The CLI is git-installed:

1. `install.sh` clones or refreshes the public repository.
2. It checks out `main`.
3. It installs dependencies.
4. It builds local `dist/`.
5. It links the `rlmx` executable into the user's bin directory.

After install, `rlmx update` performs the same update path in-place against `origin/main`.

### npm channel

The npm package is SDK-only:

- npm publishes library/SDK artifacts for programmatic consumers.
- npm dist-tags are not the canonical CLI release signal.
- `rlmx --version` reports the package/runtime version embedded in the checkout, but CLI freshness is primarily determined by the git commit on `main`.

## Main release boundary

`main` is the canonical release branch.

A release happens when a PR merges from `dev` to `main`:

1. CI passes on the PR.
2. The merge lands on `main`.
3. `main` becomes the install/update target.
4. `install.sh` and `rlmx update` fetch that commit.
5. GitHub release metadata may be created from the package version, but it is not the install authority.

## Coherence invariants

- Public git tags and GitHub Releases must not lie about package contents.
- If a tag is named `vX`, the target commit's `package.json` and `src/version.ts` must also be `X`.
- `rlmx update` must never use npm to update the CLI application.
- npm publishing must not create or imply a CLI release.
- Deployment-specific private policy must stay outside public RLMX.

## Update semantics

`rlmx update`:

- Runs from the installed repository root.
- Fetches `origin main --tags`.
- Refuses to overwrite local changes unless explicitly forced.
- Resets the checkout to `origin/main` for managed installs.
- Runs dependency install and build.
- Reports old commit, new commit, and version.

This mirrors the practical Hermes model: the installer owns the app checkout; the app update command refreshes that checkout.

## Workflow implementation

The release system follows this contract:

- `CI` builds, typechecks, tests, and runs an install/update smoke against a temporary git `main` remote.
- `SDK Package` publishes npm artifacts for programmatic consumers only.
- The npm manifest does not expose a `bin`, so npm does not act as the canonical CLI installer.
- `Release Metadata` may create GitHub Releases from the package version, but only as coherent metadata.
- The rolling `dev` → `main` PR states that merging it is the application release boundary.
