# Fondly Premium — Future Billing Plan (App Store / Play Store launch)

**Status: NOT implemented yet. This is a plan for later, when Fondly goes on the app stores.**
Current live behavior stays as-is: Premium is a ₱199 one-time lifetime unlock via GCash/QR Ph/card, no trial.

## What we agreed to build later

1. **7-day free trial** — new users can activate Premium features immediately for 7 days without paying.
2. **Card required to start the trial** — during signup for the trial, the user saves a card via
   PayMongo's secure tokenization (their card number never touches our own server or database —
   PayMongo handles that and gives us back a safe reference token).
3. **Auto-charge after 7 days** — on day 7, the server automatically charges ₱199 to that saved card
   via PayMongo, using the saved payment method token (an "off-session" charge).
4. **GCash/QR Ph users are NOT eligible for the trial path** — those payment methods are one-time,
   redirect-based, and can't be auto-charged later without the user actively re-approving in the
   GCash app at that moment. Card-only for the trial + auto-bill flow.
5. **Terms & consent screen required before starting the trial** — the user must explicitly check a
   box / tap "I agree" on a plain-language notice before their card is saved, covering:
   - That their card will be automatically charged ₱199 when the 7-day trial ends, unless they cancel first.
   - How to cancel before being charged (needs a real "Cancel trial" button/flow — not built yet either).
   - That this is a one-time charge (matches the current one-time-lifetime model), not a recurring subscription.
   - A support contact / way to dispute or request a refund.

## Real constraints to keep in mind before building this

- **PayMongo does not support auto-recurring debits for GCash or QR Ph.** Only saved *cards* can be
  charged automatically later (via PayMongo's Payment Methods / off-session charge flow). Building
  "auto-deduct from GCash" as literally requested is not technically possible without a separate
  enterprise agreement directly with GCash — not available through a standard PayMongo integration.
- **Never store raw card or bank account numbers on our own server/database.** Any saved-payment-method
  flow must go through PayMongo's own tokenization APIs. Our database should only ever store the
  PayMongo-issued reference token, never the actual card number.
- **Regulatory exposure**: recurring/auto-billing real users' money, even a small one-time-after-trial
  charge, likely means needing proper business registration and compliance attention (BSP oversight
  applies to payment service providers in the Philippines). Worth getting real legal review of the
  terms/consent text before this goes live to the public app stores — the draft above is a plain-language
  starting point, not vetted legal language.
- **Cancellation flow is required** — a trial that can silently charge someone needs an equally easy way
  to cancel before the charge happens, both for basic fairness and likely for app store review
  requirements (Apple/Google both scrutinize auto-renewing/auto-charging trial flows closely during
  app review).

## Rough build checklist (for when we pick this up)

- [ ] Add `trial_started_at`, `trial_card_token` (or similar), `trial_status` columns to `premium_status` (or a new table)
- [ ] New endpoint: start trial (save card via PayMongo, record trial start time, unlock premium features immediately)
- [ ] New endpoint / cron: check trials that hit day 7, auto-charge via PayMongo using saved token
- [ ] New endpoint: cancel trial (before day 7, prevents the auto-charge)
- [ ] Terms & consent screen in the frontend, must be agreed to before card is saved
- [ ] Reminder notification (email/push) 1-2 days before the trial ends, warning of the upcoming charge
- [ ] Handle failed auto-charge gracefully (card declined, etc.) — downgrade back to free, notify user
