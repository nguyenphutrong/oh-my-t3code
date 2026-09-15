# Oh My T3Code release checklist

This fork's first release path publishes desktop installers and self-contained CLI archives to
GitHub Releases. It deliberately does not publish npm, AUR, hosted web, relay, marketing, or mobile
artifacts.

## Release workflow

`.github/workflows/release.yml` supports:

- a pushed `vX.Y.Z` tag for a stable release of that commit;
- manual `workflow_dispatch` with `channel=stable` and an optional version;
- manual `workflow_dispatch` with `channel=nightly` or `channel=preview`.

There is no scheduled release. A manual stable release without a version uses
`apps/server/package.json`. Nightly and preview versions are generated from the desktop package
version, date, and Actions run number.

The workflow runs release checks, builds the shared JavaScript bundle once, then packages:

- macOS arm64 and x64 DMGs;
- Linux x64 and arm64 AppImages;
- Windows x64 and arm64 NSIS installers;
- CLI archives for macOS arm64, Linux x64/arm64, and Windows x64/arm64;
- `SHA256SUMS` for every CLI archive.

Windows desktop artifacts embed the matching Linux CLI archive for WSL. macOS x64 has no CLI
archive because Node single-executable builds do not support that target reliably.

Preview releases omit updater manifests. Stable and nightly releases include the updater metadata
consumed by the desktop app.

## Naming and ownership

- Product name: `Oh My T3Code`
- CLI, archive prefix, and executable: `oh-my-t3code`
- Desktop app ID: `com.nguyenphutrong.ohmyt3code`
- Default data directory: `~/.oh-my-t3code`
- Release repository: `nguyenphutrong/t3code`

The internal `@t3tools/*` workspace names and `T3CODE_*` environment variables remain technical
implementation identifiers. The MIT license and upstream copyright notices must remain intact.

## Credentials

All signing is optional. Without credentials, the workflow still produces unsigned artifacts.

For signed and notarized macOS artifacts, configure:

- `CSC_LINK`
- `CSC_KEY_PASSWORD`
- `APPLE_API_KEY`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`
- `MACOS_PROVISIONING_PROFILE`
- repository variable `APPLE_TEAM_ID`

The Apple Developer App ID and provisioning profile must belong to
`com.nguyenphutrong.ohmyt3code`. Configure `CLERK_PASSKEY_RP_DOMAINS` only after the fork owns the
corresponding Clerk and associated-domain setup.

For signed Windows artifacts, configure:

- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_SECRET`
- `AZURE_TRUSTED_SIGNING_ENDPOINT`
- `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`
- `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`
- `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`

Do not reuse upstream Clerk, relay, Expo, Apple, Google Play, Vercel, Cloudflare, npm, or telemetry
credentials. `.env.example` intentionally leaves cloud configuration blank. The relay and mobile
production workflows are manual-only until fork-owned services are configured.

## First release procedure

1. Confirm CI passes on the commit to release.
2. Manually dispatch `Release` with `channel=preview` to exercise the complete artifact graph.
3. Download and smoke-test representative CLI and desktop artifacts. Unsigned artifacts will show
   normal operating-system warnings.
4. Fix any packaging issue and repeat the preview; do not overwrite an existing release.
5. Set all package versions to the stable version and commit them, or provide the exact version in
   the manual workflow input.
6. Dispatch `Release` with `channel=stable`, or push an annotated `vX.Y.Z` tag for the exact commit.
7. Verify the GitHub Release contains desktop installers, five CLI archives, updater metadata, and
   `SHA256SUMS`.
8. Verify a fresh CLI install and desktop auto-update against the published release.

The workflow creates a real GitHub Release. Running it is a publishing action, not a dry run.

## Artifact smoke checks

For a downloaded CLI archive, verify its checksum and version before use:

```sh
sha256sum -c SHA256SUMS --ignore-missing
tar -xzf oh-my-t3code-<version>-linux-x64.tar.gz
./oh-my-t3code-<version>-linux-x64/oh-my-t3code --version
```

On Windows, use the `.zip` archive and run `oh-my-t3code.exe --version`.

The installers in `scripts/install.sh` and `scripts/install.ps1` download from this fork's GitHub
Releases, verify `SHA256SUMS`, and install the `oh-my-t3code` launcher.

## Deferred release surfaces

Before enabling any of these, assign fork-owned accounts, identifiers, domains, credentials, legal
copy, and monitoring:

- npm package `oh-my-t3code` and optional platform packages under an owned scope;
- Homebrew, WinGet, and AUR distribution;
- hosted web and marketing sites;
- T3 Connect relay and Clerk authentication;
- Expo project, Apple App Store, Google Play, APNs, and FCM;
- telemetry endpoints and a public privacy policy.

Keep their workflows manual or disconnected from the main release until the corresponding surface
is fully owned and tested by this fork.
