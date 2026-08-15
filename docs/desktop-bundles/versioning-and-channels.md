# Versioning and Update Channels

This document explains how Hermes versions itself and how a user
chooses which updates to take. Two channel systems exist. The
`main`/`stable` channels serve Git installs. The updater feeds serve
the desktop app.

## SemVer releases

Releases are now SemVer tags: `vX.Y.Z`. The historical CalVer tags
(`v2026.7.20`) still exist in history, but new releases never create
them.

`scripts/release.py` owns the release:

```
python scripts/release.py --bump minor --publish
```

The script does the following:

1. Reads the current version from `hermes_cli/__init__.py`.
2. Computes the next SemVer version.
3. Updates every version file: `hermes_cli/__init__.py`,
   `pyproject.toml`, `uv.lock`, `apps/desktop/package.json`, and
   `package-lock.json`. The version in the desktop manifest stays
   aligned with the root Python package, because the Python package
   owns the canonical value.
4. Generates a changelog from the commits since the last tag.
5. Creates the tag and drafts a GitHub release.

The draft release is the handoff point. The desktop-bundled release
workflow watches for `vX.Y.Z` tag pushes, builds the installers, and
attaches them to the draft. Publishing is a separate,
deliberate step: `gh release edit vX.Y.Z --draft=false`.

The SemVer matcher caps the major at three digits. That is what keeps
a four-digit-year CalVer tag from sorting above every SemVer release
in a numeric comparison.

`--first-release` covers the first release with no previous tag.
`--date` overrides the release-date metadata for a belated release.

## The install stamp

`scripts/write_install_stamp.py` writes `install-stamp.json`. Every
packager calls it: Docker, Nix, and the desktop app. The stamp is the
single provenance record:

| Field | Meaning |
|---|---|
| `commit` | The exact commit, or a zero fallback. |
| `commitDate` | Commit timestamp. |
| `branch` | Branch name, when known. |
| `dirty` | Whether the tree had uncommitted changes. |
| `source` | Where the facts came from: `ci`, `local`, `docker`, `nix`, `fallback`. |
| `distribution` | The steward: `docker`, `nix`, `desktop-app`. |
| `baseVersion` | The package version. |
| `displayVersion` | `baseVersion` plus `+N` distance, or `+?` when dirty. |
| `distance` | Commits since the release tag. |
| `payload` | `bootstrap`, `bundled`, or `light`. |
| `tag` | The release tag, always set for bundled and light. |

The stamp is a constant of the artifact. The desktop build bakes it
into the main bundle as the `__HERMES_INSTALL_STAMP__` define. It
cannot be missing, stale, or edited after signing.

## Version display

`hermes_cli/version_info.py` answers "what version is this?" The
resolution order is fixed:

1. The install stamp, for packaged builds. Authoritative.
2. Live git, for source and dev installs with a `.git` directory.
3. Unknown. No stamp and no git, so the provenance is unknown.

`__version__` remains the package and API version. The display adds a
suffix only when it can prove the distance: `v0.27.0+12` means twelve
commits past the `v0.27.0` tag. A dirty tree with no resolvable
distance shows `+?`.

The distance probe tries the SemVer tag first, then the legacy CalVer
tag. That keeps existing CalVer-tagged releases displaying a correct
distance during the transition.

A light stamp is a hard error for a Python process. The artifact
contains no Python. A Python process reading its own stamp as light
means the artifact was mispackaged. The readers raise rather than
misclassify the tree.

## The desktop updater feeds

The desktop app uses electron-updater, which reads feed files from a
GitHub release. Two feeds exist, one per variant:

| Variant | Channel | Feed file |
|---|---|---|
| Hermes (bundled) | `latest` | `latest*.yml` |
| Hermes Light | `light` | `light*.yml` |

The channel is part of the product identity
(`apps/desktop/product-identity.cjs`). The feed's owner and repo come
from `GITHUB_REPOSITORY`, so a fork's builds publish to and update from
the fork's own releases. That is the fork-updater-channel behavior. A
fork must not point users at the upstream feed.

Bundled installs are locked to the stable vocabulary. The update-check
report says `channel: stable`. Every renderer surface can use release
language without probing the install manifest.

## The channel settings, one table

| Setting | Where | Applies to | Values |
|---|---|---|---|
| `update.channel` | `config.yaml` | Git installs | `auto` (default), `main`, `stable` |
| Channel in manifest | `.hermes-install.json` | Git installs | `main` (default), `stable` |
| Updater channel | Product identity, build time | Desktop app | `latest`, `light` |
| Steward versioning | Install stamp | Sealed trees | None. The steward owns it |

The effective channel for a Git install resolves in this order:

1. Bundled installs are always `stable`. The config cannot override
   what the installer ships. Eject first to change this.
2. `update.channel` from config, when it is `stable` or `main`. The
   values `auto`, empty, and unknown fall through.
3. The channel from the manifest. The source default is `main`.

A sealed tree never asks. Its steward owns versioning, and `hermes
update` says so in plain words, with the correct steward command.
