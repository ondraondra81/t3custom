# T3 Custom desktop distribution

The fork's integration branch is `custom`; `upstream` points to `pingdotgg/t3code`.
Keep the feature's code under `t3custom` modules and the upstream integration edits small.
The Labs switch hides the organizer without deleting groups or coordination threads.
Each server stores its own tree under its configured state directory; Mac and MF1 do not replicate trees.

## First Apple Silicon preview

The **T3 Custom macOS preview** workflow checks changes, packages the existing desktop build,
and opens the packaged app against an isolated database fixture. Download its
`t3custom-macos-arm64` artifact. It contains the DMG, commit ID and SHA-256 checksums.

This preview has no Developer ID signature or notarization and no automatic update feed.
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
releases daily. It opens a draft integration PR and explicitly dispatches the desktop workflow for it.
Merge conflicts stop the job, and existing integration branches are preserved for manual fixes.
The explicit dispatch is needed because a push made with GitHub's workflow token does not start downstream workflows.
Repository settings must permit Actions to create pull requests.

Keep upstream's hosted-service, npm-publishing and release workflows disabled on the fork.
Our workflow has no upstream deployment secrets and never publishes the official npm package.

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
