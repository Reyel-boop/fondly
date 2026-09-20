# Fondly — connected prototype

Your latest Stitch export, wired into one clickable app. Every bottom-nav
button and the sign-in screen now actually take you to a real page instead of
sitting there dead.

## How to open it

1. Open the `fondly-app` folder in VS Code.
2. Install the **Live Server** extension if you don't have it.
3. Right-click `index.html` → **Open with Live Server**.
4. It opens on the sign-in screen. Submitting the form (or tapping the
   biometric button) takes you into `home.html`.

Don't just double-click the HTML files — the pages link to each other by
relative filename (`home.html`, `breakdown.html`, etc.), which needs an actual
local server to resolve properly. Live Server is the easiest way to get that.

## Pages and how they connect

| File | Screen | Bottom nav tab |
|---|---|---|
| `index.html` | Sign in | — (goes to Home on submit) |
| `signup.html` | Create account | — (opened from the sign-in screen) |
| `home.html` | Home — animated squirrel, interactive principal pot | Home |
| `breakdown.html` | Spending breakdown, burn trajectory, cycle reports | Breakdown |
| `suggestions.html` | Smart coach nudges | Coach |
| `goals.html` | Goals / cushion / target progress | Goals |
| `log-outflow.html` | Full-page outflow logging | Activity |
| `cash-in.html` | Add income to your pot | — (opened from Home, not a nav tab) |

All five bottom-nav pages share the same nav bar (Home, Breakdown, Coach,
Goals, Activity). Every one of those buttons now sends you to the matching
file — the nav bar is also fixed to sit properly centered on screen (an
earlier export had it pinned to the left edge on wider viewports).

`cash-in.html` is reached from Home's new "Cash In" button, sitting next to
the existing "Log Expense" button. It mirrors the outflow-logging page's
layout and PH payment methods, but adds to your pot instead of subtracting —
pick a source (Salary, Freelance, Gift, Refund, etc.), an amount, and how it
arrived (GCash, Maya, QR Ph, Cash, Bank).

`signup.html` is reached from the "Create an account" link on the sign-in
screen. It collects name, email/phone, password (with a confirm-password
match check), and a terms checkbox, and — same as sign-in — submitting or
tapping the biometric button takes you into `home.html`. "Sign in" at the
bottom links back to `index.html`.

## Alt versions (not linked into the nav)

Stitch generated two designs for four of the screens. I picked one as the live
page for each and kept the other in `alt-versions/` so nothing's lost:

- `alt-versions/home-principal-log.html` — alternate Home, principal-log focused
- `alt-versions/breakdown-patterns.html` — alternate Breakdown, pattern-focused
- `alt-versions/suggestions-nudges.html` — alternate Coach screen
- `alt-versions/log-outflow-ph-payment-methods.html` — alternate outflow-logging
  screen, closer to the GCash/Maya/QR Ph payment-method layout

If you'd rather use one of these, rename it to match its slot (e.g.
`home-principal-log.html` → `home.html`) — it'll pick up the same nav wiring
automatically since the fix targets the nav bar itself, not the page content.

## What's not wired yet

- "Forgot password" and "Create an account" on the sign-in screen are still
  placeholders.
- This is a front-end prototype only — no real backend, login, or data
  storage. Every number is Stitch's sample data. Hooking this up to a real
  API/database is the next step.

## Assets

- `assets/icon-reference.png` — the squirrel icon concept as a flat
  screenshot. Not a proper transparent app-icon file yet — treat it as a
  visual reference.
