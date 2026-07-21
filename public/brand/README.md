# Brand marks

Transparent paper-boat marks for The Ebb & Flow.

| File | Use on |
|------|--------|
| `logo-mark-light.svg` / `logo-mark-light-*.png` | Dark / navy surfaces (email masthead, public hero, admin) |
| `logo-mark-dark.svg` / `logo-mark-dark-*.png` | Light / cream surfaces |
| `logo-quill-*.svg` | Optional quill-mast variant |

All marks have **no background** (transparent). Pick light vs dark so the boat contrasts with whatever sits behind it.

**Email:** the masthead logo is embedded inline (`cid:ebb-flow-logo`) from `logo-mark-light-128.png` so it does not depend on `APP_URL`.

**Site / admin:** served from `/brand/…` via Express static files (also copied into `dist/public` on build).

To swap in original artwork: replace these files (keep the same names/sizes) and redeploy.
