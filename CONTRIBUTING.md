# Contributing

This file covers the repository layout and the release process. If you just want to debug an Actor,
see the [root README](README.md) and the package READMEs it links to.

## Repository layout

- [`javascript/`](javascript/) — the npm package (`bin/`, `lib/`), its README, and a sample TS Actor
  in `example-actor/`.
- [`python/`](python/) — the PyPI package (`src/actor_debugger/`) and its README.
- [`.github/workflows/`](.github/workflows/) — release automation, one manually started workflow per
  package (see [Releasing](#releasing) below).

## Releasing

Each package is released independently by its own manually started workflow. Both workflows refuse
to run on any branch other than `master`, and both push their tag and create the GitHub release
themselves — do not create tags or releases by hand.

### npm (`javascript/`)

Publishing to npm is done by [`.github/workflows/publish.yml`](.github/workflows/publish.yml),
started manually from the Actions tab. It publishes via **npm Trusted Publishing** (OIDC) — no npm
token or repository secret, and provenance attestations are generated automatically. The trusted
publisher configured on npmjs.com is: repository `apify/actor-debugger`, workflow `publish.yml`
(the workflow file name must stay exactly that). To cut a release:

1. Bump the version in `javascript/package.json` in a PR and merge it to `master`:

   ```bash
   cd javascript
   npm version patch --no-git-tag-version   # or minor / major
   ```

2. Open **Actions → Publish to npm → Run workflow** on `master`.

The workflow refuses to run on any other branch, or if that version is already on npm or its
`vX.Y.Z` tag already exists. It then syntax-checks the sources, smoke-tests both modes (disabled
pass-through and the debug server with `/json/list` + DevTools frontend), checks the pack contents,
runs `npm publish` from `javascript/`, and finally **pushes the `vX.Y.Z` tag and creates the GitHub
release** with generated notes.

### PyPI (`python/`)

Publishing to PyPI is done by
[`.github/workflows/publish_to_pypi.yml`](.github/workflows/publish_to_pypi.yml), started manually
from the Actions tab. It publishes via **PyPI Trusted Publishing** (OIDC) — no API token or
repository secret. The trusted publisher configured on PyPI is: project `actor-debugger`,
repository `apify/actor-debugger`, workflow `publish_to_pypi.yml` (the workflow file name must stay
exactly that). To cut a release:

1. Bump the version in `python/pyproject.toml` and `python/src/actor_debugger/__init__.py` in a
   PR and merge it to `master`.
2. Open **Actions → Publish to PyPI → Run workflow** on `master`.

The workflow refuses to run on any other branch, if the two version strings disagree, or if that
version is already on PyPI or its `py-vX.Y.Z` tag already exists. It then installs the package,
smoke tests the CLI and the served debugger UI, builds sdist+wheel, uploads them, and finally
**pushes the `py-vX.Y.Z` tag and creates the GitHub release** with generated notes.
