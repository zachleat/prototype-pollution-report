# Prototype Pollution Report

Compares `npm audit` results over time for each framework's official packages. Requires Node 24+ and npm 11+; run `npm install` once for the Font Awesome icons.

- `node collect.js` adds today's snapshot to `data/snapshots.json`.
- `node collect.js --months 12` backfills the first of each month for a year; dates can also be passed directly (`node collect.js 2025-06-01`), and `--only 11ty,astro` limits frameworks.
- `node render.js` writes `index.html`.

Ecosystems are defined in `frameworks.js` as npm orgs (optionally narrowed by a `match` pattern) plus `include`/`exclude` lists. Deprecated, placeholder (`0.0.0`), nightly/edge/canary and platform-binary packages are skipped.

Past dates are point-in-time: packages resolve with `npm install --before`, and only advisories published by that date count (publish dates from OSV.dev, cached in `data/advisories.json`).

Ecosystem installs use `--legacy-peer-deps` because official packages' peer ranges conflict; core packages are also audited alone with their required peers installed.

Next.js's precompiled `dist/compiled` packages are audited as regular dependencies, with versions read from the release tag's `package.json` files on GitHub.

Icons:

- [Font Awesome](https://fontawesome.com/)
- [Simple Icons](https://simpleicons.org/) (CC0): Nuxt, Next.js, Astro, Gatsby and TanStack logos in `logos.js`
