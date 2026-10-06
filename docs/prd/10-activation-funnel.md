# PRD 10: Activation and growth funnel

Priority: **P1**

## Problem
People are arriving (47 accounts, 18 in September), but most never reach a working node or a successful API call.

## Funnel today (prod, 2026-10-06)
| Step | Count |
|---|---|
| Accounts (auth.users) | 47 |
| Email confirmed | 26 (21 unconfirmed; 11 of 18 September sign-ups unconfirmed) |
| Linked a node pubkey to the account (`pubkey_links`, distinct users) | 14 |
| Nodes ever registered (`providers`) | 41 |
| Nodes alive in the last 24 h | 2 |
| Nodes alive now | 0 |
| Jobs completed, all time | 629 (most from our own test nodes) |

## Current state (evidence)
- Auth is email + password with a confirmation link (`GOTRUE_MAILER_AUTOCONFIRM=false`, SMTP via Resend). Auth logs show `403: Email link is invalid or has expired / One-time token not found` from Google IPs (172.253.x), which is Gmail's link scanner consuming the one-time token before the person clicks. Users then hit `email_not_confirmed` on login (6 in the last ~11 days of logs).
- The house auth pattern is magic link + passkey; this site still uses passwords.
- Nothing follows up with a user who signed up but never ran a node, or whose node went silent.
- The dashboard is the only place to see your node; there is no "your node is offline" signal.

## Requirements
1. Confirmation that survives link scanners: send a 6-digit OTP (Supabase `verifyOtp`) or a link to a page with a "Confirm" button that POSTs the token, instead of a GET that spends it.
2. Resend-confirmation button on the login error.
3. Onboarding email sequence: day 0 (install one-liner for your OS), day 2 (if no node linked: help), day 7 (if node silent: restart command). Respect unsubscribe.
4. First-run success check: after `infernet setup`, the CLI runs one real job through the control plane and prints the result and the dashboard URL.
5. Funnel numbers in the daily report: sign-ups, confirmed, linked node, node alive 24 h, first completed job.
6. A "try it" path for API users that works with no node (depends on PRD 01 supply).

## Acceptance criteria
- Confirmation rate of new sign-ups above 80% over 30 days.
- Sign-up to first live node above 30% over 30 days.
- Funnel section present in the daily report.
