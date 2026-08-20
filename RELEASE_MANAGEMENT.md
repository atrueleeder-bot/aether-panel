# Aether Panel release management

**Aether Panel now uses a managed Windows installer for normal releases.** The portable executable remains an offline recovery artifact, but it is intentionally not the update path. The installed NSIS release can download a verified update, then asks the user to restart and install it. Windows updates are not applied automatically during shutdown.

## One-time GitHub setup

Create a GitHub repository for the source archive, push this project to its default branch, and enable GitHub Actions. The included release workflow runs when a version tag is pushed. Releases must remain public when using the in-app GitHub release option; do not enter credentials or tokens into Aether Panel.

After the first release is published, open **Updates & rollback** in the installed application and set the HTTPS release feed to the repository URL in this form:

```text
https://github.com/OWNER/REPOSITORY
```

Select **Stable** for normal use. Select **Preview** only on test computers or by users who accept beta releases.

> The first installed release must have its feed configured once. After that, Aether Panel remembers the selected channel and release location in its local application data.

## Version and release-name policy

Aether Panel uses [Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`. Until the application is considered broadly stable, releases remain in the `0.x` series. The same version must be used in `package.json`, the annotated Git tag prefixed with `v`, the installer filename, the GitHub release title, and the in-app update metadata.

| Release purpose | Version pattern | Tag example | Recommended GitHub release name | Update channel |
|---|---:|---|---|---|
| Normal stable release | `0.MINOR.PATCH` | `v0.1.1` | `Aether Panel 0.1.1` | Stable |
| Feature release | Increase `MINOR` | `v0.2.0` | `Aether Panel 0.2.0` | Stable |
| Bug or security fix | Increase `PATCH` | `v0.2.1` | `Aether Panel 0.2.1` | Stable |
| Preview build | `0.MINOR.PATCH-beta.N` | `v0.3.0-beta.1` | `Aether Panel 0.3.0 Preview 1` | Preview |
| Follow-up preview | Increase `beta.N` | `v0.3.0-beta.2` | `Aether Panel 0.3.0 Preview 2` | Preview |
| Recovery release | A new higher version | `v0.2.2` | `Aether Panel 0.2.2` | Channel affected |

Keep the GitHub release title exact and predictable; the workflow generates it automatically. Put friendly context such as **Server Profiles**, **Stability Fixes**, or **Recovery Release** in the release-notes heading instead of changing the versioned title.

> **Version safety rule:** Never reuse a published version number and never ask the updater to move a client to a lower version. If `0.2.1` is faulty, publish the known-good code as `0.2.2`. The updater can then move users forward safely.

## Release process

| Release kind | Version example | Channel | Intended audience | Required files |
|---|---:|---|---|---|
| Stable | `0.1.2` | Stable | All users | NSIS installer, `latest.yml`, blockmap files, release notes |
| Preview | `0.1.3-beta.1` | Preview | Test users | NSIS installer, `beta.yml`, blockmap files, release notes |
| Recovery release | `0.1.4` | Same channel affected | Users on a bad release | NSIS installer containing known-good code, `latest.yml` or `beta.yml` |
| Offline recovery | Any retained release | Manual | Break-glass recovery | Portable executable and previous NSIS installer |

The project version in `package.json` is the release identifier. Update it, commit the change, and tag the commit with the same version prefixed by `v`, for example `v0.1.2`. The release workflow packages the NSIS installer and uploads the installer, update manifest, and blockmap files to the matching GitHub release.

```powershell
# Example: stable release
# 1. Change package.json version to 0.1.2 and update release notes.
git add package.json pnpm-lock.yaml
 git commit -m "release: 0.1.2"
git tag v0.1.2
git push origin main --tags
```

For a preview release, use a semantic prerelease version such as `0.1.3-beta.1` and the tag `v0.1.3-beta.1`. The workflow marks the GitHub release as a prerelease.

### Copy-ready release checklist

| Step | Stable example | Preview example |
|---|---|---|
| Choose the next version | `0.2.0` for features; `0.2.1` for fixes | `0.3.0-beta.1` |
| Update `package.json` | Set `version` to `0.2.0` | Set `version` to `0.3.0-beta.1` |
| Commit | `git commit -am "release: 0.2.0"` | `git commit -am "release: 0.3.0-beta.1"` |
| Create the annotated tag | `git tag -a v0.2.0 -m "Aether Panel 0.2.0"` | `git tag -a v0.3.0-beta.1 -m "Aether Panel 0.3.0 Preview 1"` |
| Publish | `git push origin main v0.2.0` | `git push origin main v0.3.0-beta.1` |
| Verify | Confirm `latest.yml`, installer, and blockmap appear on the GitHub release | Confirm `beta.yml`, installer, and blockmap appear on the GitHub prerelease |

For a recovery, begin from the last known-good code, set a **new higher** version such as `0.2.2`, and publish it under the affected channel. State `Recovery Release` prominently in the generated release notes; do not reuse the faulty version or lower the version number.

## Updating an installed client

The application never replaces its own files while it is running. In **Updates & rollback**, select **Check for updates**, review the available version and release notes, then choose **Download update**. When the download is complete, select **Restart & install**. This explicit handoff avoids background replacement during a Windows shutdown and gives the user a clean point to stop servers first.

Before restarting for an update, stop all running Minecraft servers. Aether does not delete selected server workspaces or managed Minecraft files during an application update.

## Rollback policy

Do not publish the same version number again and do not normally force a client to downgrade. If version `0.1.3` is defective, publish the last known-good code as a **new higher recovery version**, for example `0.1.4`. This lets the updater move forward safely while restoring the prior working behavior.

Keep the last three stable NSIS installers and their release notes published. If a user cannot start the application, they can manually run an older retained installer after backing up their Aether application data. Portable builds are reserved for diagnostics or emergency recovery, not normal updates.

| Incident | Action |
|---|---|
| Preview release is faulty | Remove or mark the preview release as superseded, then publish a newer preview recovery release. Stable users are unaffected. |
| Stable release is faulty before broad deployment | Pause promotion, publish a new higher recovery release from the known-good commit, and state the recovery version in the release notes. |
| Stable release is faulty after broad deployment | Publish the higher recovery release immediately, retain the affected installer for audit, and identify it as superseded in the GitHub release notes. |
| Update cannot be installed | Use a retained NSIS installer manually. Use a portable executable only for offline diagnosis or emergency access. |

## Security checklist

Use a code-signing certificate for public Windows releases when possible. Sign the NSIS installer and application executable in the release workflow. Keep the GitHub repository, tags, and release artifacts protected from unreviewed writes. The updater accepts HTTPS feeds only; do not use a local file path, HTTP endpoint, or ad-hoc download link.

The app’s update center uses two channels: **Stable** maps to `latest.yml`, and **Preview** maps to `beta.yml`. Stable users do not receive preview releases. Retain each generated manifest next to its matching installer in the GitHub release.

## References

[1] [Electron Builder — Auto Update](https://www.electron.build/docs/features/auto-update/)
[2] [Electron Builder — Release channels](https://www.electron.build/docs/tutorials/release-using-channels/)
[3] [Electron Builder — Windows NSIS](https://www.electron.build/docs/nsis/)
