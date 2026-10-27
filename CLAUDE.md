# Notes for Claude

## Versioning

The app's version is `MAJOR.MINOR.PATCH-<commit>` (scripts/build-version.mjs). MAJOR and MINOR are the first two numbers of `version` in `apps/web/package.json`; PATCH is counted automatically from the commits on master since that line last changed, so it is never edited by hand and starts again at 0 after each bump.

In every change, decide whether it earns a bump, and if so make it in the same PR:

- **Major** (`1.4.0` → `2.0.0`): a new capability that needs a new APK to work (native code, a Capacitor plugin, a permission, a manifest change), or a change that devices on the old version can no longer work with (a sync protocol or data change they do not understand).
- **Minor** (`1.4.0` → `1.5.0`): a new feature, a change in behaviour a user will notice, or a fix that lives in native code (it still needs a new APK, but it is a fix).
- **No bump**: a fix, a refactor, tests, docs or a dependency update. PATCH goes up by itself.

Only one bump per PR, the highest that applies. Keep the third number at `0` in package.json; it is ignored. Say in the PR description which bump you chose and why.
