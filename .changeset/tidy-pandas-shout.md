---
type: Fixed
pr: 5235
---
**OpenCode v2 loads `gsd-core.js` and enforces GSD guards again** — the adapter now registers through the native v2 plugin API and spawns hooks with a real node binary instead of failing schema validation and silently no-opping every guard.
