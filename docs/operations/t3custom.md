# T3 Custom desktop distribution

The fork's integration branch is `custom`; `upstream` points to `pingdotgg/t3code`.
Keep the feature's code under `t3custom` modules and the upstream integration edits small.
The Labs switch hides the organizer without deleting groups or coordination threads.
Each server stores its own tree under its configured state directory; Mac and MF1 do not replicate trees.

## First Apple Silicon preview

The **T3 Custom macOS preview** workflow checks changes, packages the existing desktop build,
and opens the packaged app against an isolated database fixture. Download its
`t3custom-macos-arm64` artifact. It contains the DMG, commit ID and SHA-256 checksums. Pushes to `custom` also prepare a
complete draft GitHub release; a manual workflow dispatch can request the same. Publish the draft
after reviewing the checks and package. Integration PR builds only produce artifacts.

The preview is ad-hoc signed for Apple Silicon, with no Developer ID signature, notarization
or automatic update feed. No Apple Developer account is needed for ad-hoc signing.
Install each version manually; macOS may require allowing it in Privacy & Security.
The fork uses `~/.t3custom` and a separate Chromium profile. It does not import an official
installation's live state. Pair to an existing server through Connections, or add projects
to the new local environment. An official server will not offer group storage until upgraded.
Back up both the database and group metadata before any later migration.

`T3CUSTOM_DESKTOP=1` enables the fork's build identity. The preview deliberately does not
register the official application's OS URL handlers; open the app and add remote connections
inside it. The desktop's internal renderer origin stays compatible with upstream authentication.

## Upstream updates

Once `custom` is the default branch, **T3 Custom upstream integration** checks stable upstream
releases daily. `.t3custom-upstream` records the merged upstream commit; each integration updates
it so validation covers the fork delta instead of every historical upstream change. It opens a draft integration PR and explicitly dispatches the desktop workflow for it.
Merge conflicts stop the job, and existing integration branches are preserved for manual fixes.
The explicit dispatch is needed because a push made with GitHub's workflow token does not start downstream workflows.
Repository settings must permit Actions to create pull requests. The repository-only writable
deploy key in `T3CUSTOM_SYNC_SSH_KEY` pushes integration branches: GitHub's built-in workflow token
cannot push upstream commits that change workflow files. Rotate it by replacing the repository
deploy key and Actions secret together; never use a personal account token for this job.

Keep every upstream workflow disabled on the fork, including `ci.yml` (its Blacksmith runners
are unavailable here), hosted-service deployments, npm publishing and releases.
Our workflow has no upstream deployment secrets and never publishes the official npm package.

## Separate MF1 server

An official MF1 server remains usable from the custom desktop, but cannot store groups.
Deploying the fork there is a separate operation after desktop acceptance; do not replace the
live workshop server as part of testing this app.

For a separate instance, check out the same `custom` commit as the desktop, install the Node
version in `package.json` and Vite+, and provision native Linux build prerequisites (including
`pkg-config` and the libsecret development headers) through the host's normal administration.
From the checkout:

```sh
vp i --frozen-lockfile
vp run --filter t3 build
node apps/server/dist/bin.mjs --base-dir "$HOME/.t3custom-mf1" --host 127.0.0.1 --port 4780
```

Choose a free port and keep the T3 home outside any Git checkout so Scratch is available.
This uses the source checkout's dependencies; retain that checkout when running the service.
Expose it through the workshop's existing approved private routing or Tailscale setup and pair
it in the desktop's Connections settings. Add projects to this separate instance.

For an eventual migration, first stop only the server being migrated and back up its entire
T3 home, including SQLite, settings, secrets and `userdata/t3custom`. Restore a copy into the
new home, validate it on a separate port, then switch the service. Keep the old home and binary
untouched for rollback; never run the old binary against a database the new one has migrated.
If migrating an existing host identity, avoid serving both copies to the same client at once.

## Signed releases later

Developer ID signing and notarization need paid Apple Developer Program membership. Store the
certificate and notarization credentials in GitHub Secrets, available only to a protected release
job after checks. Do not sign untrusted pull-request code.

Use the existing packaging script with `--signed` and
`T3CODE_DESKTOP_UPDATE_REPOSITORY=ondraondra81/t3custom`. Publish a complete release with DMG,
ZIP, blockmaps and `latest-mac.yml`; preview versions deliberately have no updater feed.
Verify an upgrade between two signed builds on the Mac before enabling that distribution path.
Version our builds monotonically and record the upstream SHA independently. A binary downgrade
does not reverse database migrations. MF1 server updates are a separate deployment.
