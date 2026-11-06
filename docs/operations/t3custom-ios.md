# T3 Custom for iPhone and iPad

The fork uses the existing React Native client. `T3CUSTOM_MOBILE=1` selects the
T3 Custom identity, Apple team `RNT8PBS36F`, bundle ID `dev.ondravotava.t3custom`,
and Expo project <https://expo.dev/accounts/ondravotavas-team/projects/t3custom>.
Development builds append `.dev` to the bundle ID. Custom can coexist with the
official app; pair its connections separately.

The app connects directly to a T3 server over the local network or tailnet.
Official T3 Connect/Clerk services and upstream OTA updates are disabled in Custom.
Use TestFlight for updates. No official-server deployment is part of building the client.

## Project groups

Pair a T3 Custom server, then open **Project groups** from the thread list on
phone or the sidebar on tablet. Select an environment, create groups and subgroups,
and use a project's menu to move it into a group. The group menu can rename, move,
remove or start a coordination thread. Removing a group preserves its projects and
threads. The same server owns the same tree on desktop and mobile; different servers
have separate trees. Official servers without the capability retain normal navigation.

Coordination creates a Scratch thread and prepares an unsent prompt with the group's
projects and paths. Review and send it to start the agent. Interrupted setup offers
Retry. Offline and read-only connections cannot change groups. Concurrent edits use
the server revision and report conflicts rather than replacing another client's work.

## Build with EAS

Install the repository's dependencies with `vp install --frozen-lockfile`. From
`apps/mobile`, with Expo authentication available locally or as `EXPO_TOKEN`:

```sh
T3CUSTOM_MOBILE=1 npx eas-cli@27.5.0 build --platform ios --profile custom-simulator
T3CUSTOM_MOBILE=1 npx eas-cli@27.5.0 build --platform ios --profile custom-testflight
```

The custom profiles do not extend upstream production: they use our identity,
project and version counter, without an upstream update channel or submission target.
The simulator profile is unsigned and does not install on a physical device. The
TestFlight profile uses store distribution and remote build numbers. Set the Custom
flag even for `eas project:info` and `eas submit`, so initial config resolution selects
the fork before loading a build profile's environment.

For non-interactive signing, use an App Store Connect **team** API key with the Admin
role and a private `.p8` file outside the checkout. EAS CLI reads:

- `EXPO_ASC_API_KEY_PATH`: absolute path to the private key.
- `EXPO_ASC_KEY_ID` and `EXPO_ASC_ISSUER_ID`: the matching key identifiers.
- `EXPO_APPLE_TEAM_ID=RNT8PBS36F` and `EXPO_APPLE_TEAM_TYPE` matching the paid membership (`INDIVIDUAL` or `COMPANY_OR_ORGANIZATION`; `IN_HOUSE` is for Enterprise).

Do not reuse the macOS Developer ID certificate for iOS. EAS manages Apple Distribution
certificates and separate provisioning profiles for the app, widgets and share extension.
Never revoke unrelated certificates to make room. Never commit credentials or copy them
into chat, release notes, build output or the EAS source archive. `.easignore` excludes
credentials, generated native projects and upstream reference sources; dependencies
and native modules remain build inputs.

Create the app record in App Store Connect using the Custom bundle ID, then configure
a separate submission profile with that record's numeric Apple ID. Do not use the
upstream `production` submission profile. A successful EAS build is not yet a TestFlight
release: Apple must process the upload, and the tester must be assigned in App Store
Connect. External testers can require Beta App Review.
