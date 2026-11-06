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

By default the preview is ad-hoc signed for Apple Silicon, with no Developer ID signature, notarization
or automatic update feed. A manual signed build is available after the setup below. No Apple Developer account is needed for ad-hoc signing.
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
The explicit dispatch is needed because `upstream/*` is outside the desktop workflow's push filter,
and a PR created with GitHub's workflow token does not start downstream workflows.
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

## Developer ID signing and notarization

Paid Apple Developer Program membership is required. On the Mac, create a certificate signing
request in Keychain Access (Certificate Assistant → Request a Certificate From a Certificate
Authority → Saved to disk). In Apple Developer → Certificates, create **Developer ID Application**,
upload the request, download the certificate and open it in Keychain Access. Export the matching
identity from **My Certificates**, including its private key, as a password-protected `.p12`.
Use Developer ID Application, not Apple Development, Apple Distribution or Developer ID Installer.
If Apple asks for a certificate authority, use its current recommended G2 option.

Create an app-specific password at <https://account.apple.com/> → Sign-In and Security →
App-Specific Passwords, labelled `T3 Custom notarization`. Find the ten-character Team ID under
Membership details at <https://developer.apple.com/account/>. Never use the main Apple password.

With GitHub CLI installed and authenticated on the Mac, run:

```sh
bash scripts/t3custom/setup-apple-signing.sh
```

The helper prompts locally for the exported `.p12`, its password, Apple Account email, Team ID and
app-specific password. It uploads directly to `ondraondra81/t3custom`'s `t3custom-apple` environment:
`CSC_LINK` (base64 `.p12`), `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_TEAM_ID`, and
`APPLE_APP_SPECIFIC_PASSWORD`. Nothing is pasted into chat or committed. This environment must
allow deployments only from the **branch** `custom` (custom deployment branch policy; no tags).
Keep these as environment secrets, not repository secrets. Re-running the helper replaces them.

Dispatch **T3 Custom macOS preview** from `custom` with `signed=true` and `prepare_release=true`.
Signed builds require all credentials and fail rather than falling back to ad-hoc signing. The
packager notarizes and staples the app; the workflow also notarizes and staples the DMG. It checks
Developer ID signature, stapled tickets and Gatekeeper assessment before opening the packaged app
against fixture data and preparing a draft release. Checksums are calculated after stapling.
Only publish after these steps pass. PRs and automatic push builds remain ad-hoc with no Apple
secrets. The signed path is manual until the first real signed build has been accepted.

If notarization loses its network connection or times out after receiving a submission UUID,
dispatch the same workflow with `notarization_id=<UUID>`. This only queries Apple (and retrieves
its rejection log when available); it does not rebuild, resubmit or publish. Wait for the existing
submission's result before deciding whether a rebuild is necessary. A failed packaging run does
not retain its temporary signed bundle, so an accepted submission alone is not a downloadable release.

The fork retains its bundle ID and data directories. It uses hardened runtime entitlements without
upstream's restricted Clerk associated domains and provisioning profile; native passkey features
requiring those entitlements are unavailable. This does not configure iOS distribution.

Signing does not enable automatic updates: preview versions still have no updater feed. An updater
rollout is separate and needs ZIP, blockmaps and `latest-mac.yml`, plus an upgrade test between two
signed builds on the Mac. A binary downgrade does not reverse database migrations. MF1 server
updates remain a separate deployment.
