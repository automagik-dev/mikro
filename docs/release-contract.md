# RLMX Release Contract

RLMX follows the Hermes/Genie install/update shape:

- `scripts/install.sh` is the canonical installer.
- `rlmx update` updates an installed checkout by fetching the latest public `main` commits.
- npm is SDK-only distribution. npm is not the canonical end-user CLI release channel.
- The canonical release boundary is a PR merge into `main`.

## Versioning

rlmx uses **calendar versioning**, not semantic versioning: `0.YYMMDD.N`, where
`YYMMDD` is the **UTC** date of the build and `N` is one past the highest
existing `v0.YYMMDD.*` tag. `scripts/version.mjs` computes it and syncs every
committed version location: `package.json`, `package-lock.json`,
`src/version.ts`, and the committed build output `dist/src/version.js` and
`dist/src/version.d.ts`.

The bump is produced at **merge time** by the `Release Metadata` workflow, not
by hand, so `YYMMDD` is the UTC date the release was actually cut and `N` is the
per-UTC-day release counter for `main`.

A version number records *when* a build was cut. It carries no compatibility
promise, so consumers must read `CHANGELOG.md` — not the version delta — to
learn about breaking changes.

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
- **Publishing is manual.** The `SDK Package` workflow runs on
  `workflow_dispatch` only — it does not fire on a merge to `main`. Publish
  when the SDK surface actually changed:

  ```bash
  gh workflow run "SDK Package"
  ```

  It publishes exactly the version `main` currently holds, which is always an
  already-released, already-tagged version because `Release Metadata` bumped and
  tagged it on merge. Do **not** run `npm run bump-version` first — that would
  double-bump and publish a version no commit or tag matches.

  This keeps the contract's invariant structurally true rather than merely
  stated: a CLI release cannot trigger or imply an npm publish, and npm being
  unavailable cannot make a CLI release look failed.
- The `next` dist-tag is legacy — it was fed by a `dev` branch that no longer
  exists, so it trails `latest`. Repoint or retire it manually.
- `rlmx --version` reports the package/runtime version embedded in the checkout.
  Every release commit on `main` carries a released, tagged version, so this is a
  reliable release identifier — but the git commit on `main` remains the
  authority on CLI freshness.

## Main release boundary

`main` is the canonical release branch and the expected branch for long-lived production checkouts (for example `~/prod/rlmx`).

Use short-lived topic branches for focused source changes, then return the production checkout to `main` after merge/dogfood. The current conventions are:

- `wish/<slug>` — work executing a `.genie/wishes/<slug>` plan.
- `fix/<topic>` — targeted corrections and QA follow-ups.
- `feat/<topic>`, `chore/<topic>` — features and maintenance.

Topic branches merge **directly into `main`** by PR. There is no `dev`
integration branch. (Legacy `drogo/<topic>` branches predate this convention
and are not part of it; they should not be used or treated as an
install/update authority.)

A release happens when a topic-branch PR merges into `main`:

1. CI passes on the PR.
2. The merge lands on `main`.
3. `Release Metadata` runs. If `main`'s `package.json` version is already
   released, it bumps the calendar version, commits that bump to `main`, and
   tags the bump commit. Otherwise it releases the version the merge already
   carries (so a reviewed bump inside the PR is honoured, never double-bumped).
4. `main`'s HEAD is that release's commit, and it becomes the install/update
   target.
5. `install.sh` and `rlmx update` fetch that commit.
6. A GitHub release exists for it. **Every merge into `main` is covered by a
   release**, so release metadata always tracks `main` and never trails it. It is
   still not the install authority — the git commit on `main` is.

Runs are serialized on a `release-metadata` concurrency group, so two merges
cannot compute the same `N` or race the push to `main`. If merges land faster
than a run finishes, GitHub retains only the newest queued run, so a burst can
yield one release spanning several merges. Every commit still ships inside a
release; only the release count can be lower than the merge count.

The trailing bump commit is metadata-only: it changes version literals and
nothing else. It receives no CI run of its own, because a push made with
`GITHUB_TOKEN` does not trigger workflow runs; the tested content comes from its
parent, the merge commit that CI passed on in step 1. Its message carries
`[auto-version]`, which `Release Metadata` skips in order to break the
push -> release -> push loop. It deliberately does *not* use `[skip ci]`: that
marker is honoured by every workflow, so it would permanently exempt `main`'s
HEAD from CI even if the push were later moved to a PAT.

## Coherence invariants

- Public git tags and GitHub Releases must not lie about package contents.
- If a tag is named `vX`, the target commit's `package.json`,
  `package-lock.json`, `src/version.ts`, `dist/src/version.js`, and
  `dist/src/version.d.ts` must all be `X`. `dist/` is committed, so a git-URL
  consumer of the tag reads its `VERSION` from there.
- A tag must never be derived without committing the matching version files.
  `Release Metadata` therefore tags the bump commit and never the merge commit
  (whose version files still hold the previous version), and it asserts the
  target commit's `package.json` and `src/version.ts` against the tag name before
  publishing, failing the run rather than cutting an incoherent tag.
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
- `Release Metadata` runs on every push to `main` and guarantees a GitHub release
  for it: it computes the calendar version, commits the bump to `main` when the
  current version is already released, and tags the bump commit. Releases always
  track `main`, and only ever as coherent metadata.
- Topic-branch PRs into `main` state that merging is the application release boundary.

## Verifying a release

Because npm does not ship a `bin`, `npx rlmx` cannot work and is not a valid
post-release check. Verify a release through the git channel instead:

```bash
bash scripts/install.sh          # canonical install path
rlmx update                      # in-place refresh against origin/main
rlmx --version                   # must equal the tag and src/version.ts
node scripts/smoke-acp.mjs       # ACP handshake + prompt round-trip
```
