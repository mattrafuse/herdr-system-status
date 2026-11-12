# herdr-system-status

A Herdr mod: the window's status bar with system metrics, a VS Code–style status message, and a CPU/GPU trend popup. Public repo, shared at herdr.dev/mods (topic `herdr-mod`). `RECIPE.md` is the brief another agent builds the mod from — keep it in sync with the code, in Herdr's recipe order (what you see / how it behaves / built from / watch out / done when).

## Layout

- `mods/herdr-system-status/main.js` — the whole mod: one `View` class, polling, both render paths (bar and trends popup).
- `mods/herdr-system-status/mod.json` — `{ "place": "none" }`: the layout's `status` block places it; on its own the mod is invisible.
- `RECIPE.md` — the behavior spec. The person and what they see come first; exact numbers over vague ones; nothing the build doesn't do.
- `preview.png` — a real screenshot of the mod running. Regenerate with `herdr-app shot preview.png` while Herdr is running it.

## Working on it

- **The app runs the installed copy, not this repo.** With `watch-mod.sh` running
  (from the repo root: `setsid nohup ./watch-mod.sh >> /tmp/herdr-mod-sync.log 2>&1 &`),
  saving any file under `mods/herdr-system-status/` syncs to the installed copy within
  a second and hot-reloads there — edit the repo, the window follows. Without it, sync
  by hand: `cp -r mods/herdr-system-status ~/.config/herdr-app/mods/`
  Saving hot-reloads the running copy, which resets its state — the popup shows `Gathering samples…` until the second 5 s tick, and trend history starts over.
- Check after every change: `herdr-app check ~/.config/herdr-app/mods/herdr-system-status` — loads and renders the mod once, exits nonzero with the exact error on failure. It does not lay out the mod or run deferred work, so also try it in the app; `herdr-app status` lists runtime errors under `errors`.
- The API truth is `herdr.d.ts` and `gpui-kit.d.ts` next to `~/.config/herdr-app/AGENTS.md`. The app rewrites them on every start; never edit them.

## Traps already paid for

- `.when(cond, branch)` takes **one** branch function; a second passed as an else silently renders nothing. Use two `.when` calls with complementary conditions.
- `openOverlay` creates a **fresh copy** of the mod with empty instance state. Trend data reaches the popup through `shared("herdr-system-status")` — the bar copy publishes a snapshot every tick, the popup copy reads it. The popup copy's `init` returns early on `props()?.trends` and never samples.
- `openOverlay` with no `width` measures the mod _without_ the trends props — which renders the status bar (~420px) — so the popup comes out ~120px too wide. Pass `width: 300`; `height` may be omitted, it adapts to the content.
- A popup `at: "pointer"` opened from the bottom status bar is clipped off the window's bottom edge (it exists — `herdr-app status` lists it under `overlays` — but nothing is visible). Anchor it with the gpui-kit global `window.viewport_size()` instead; `herdr`'s `window()` has no viewport.
- The popup's anchor estimates the content's height in `openTrends` (`est`). Change the content, change `est`, or the popup overlaps the status bar.

## Data sources

`exec` per 5 s tick: `cat /proc/stat` (CPU busy fraction between samples), `awk` over `/proc/meminfo` (MemTotal / MemAvailable / MemFree), `df -kP /`, and `nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits` — after three consecutive misses it backs off 60 s and omits the GPU row silently until it answers again. Thresholds are hard-coded: CPU/RAM/GPU warn above 90%, disk below 10% free.

## Commits

This repo's git config sets the author to `mattrafuse@users.noreply.github.com` — GitHub rejects pushes from the personal email (privacy restrictions). In a shell without a gpg-agent passphrase, commit with `git -c commit.gpgsign=false commit`.
