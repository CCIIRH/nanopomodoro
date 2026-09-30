# NanoPomodoro

A pomodoro timer that sequences a DNA strand through a nanopore while you focus.

- **Focus**: a motor protein ratchets ssDNA through the pore, the raw current trace
  shows k-mer–dependent blockade levels, and basecalls stream out below.
- **Breaks**: the pore is empty and ions flow freely (open-pore current, ~215 pA).
- Plain static HTML/CSS/JS — no build step, no dependencies.

## The timer keeps running

The timer stores the session's *end time* in `localStorage` rather than counting down in memory.
Navigating away, reloading, or closing the tab doesn't stop it — when you come back, the remaining
time is recomputed from the clock. If a session ended while you were away, the page advances to
the next one and tells you. Several open tabs stay in sync.

Keys: `Space` start/pause · `R` reset · `S` skip. Settings (durations, long-break interval,
auto-start, sound) are under **Settings**.

## Deploy to GitHub Pages

```bash
gh repo create nanopore-pomodoro --public --source . --push
gh api -X POST repos/{owner}/nanopore-pomodoro/pages -f 'source[branch]=main' -f 'source[path]=/'
```

Or in the GitHub UI: **Settings → Pages → Deploy from a branch → `main` / root**.
The site appears at https://cciirh.github.io/nanopomodoro/.
