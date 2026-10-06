# PRD 08: Privacy and security claims

Priority: **P0** (the privacy policy is false) / P1 (E2E, sandbox)

## Problem
The privacy policy says prompts and completions are not stored. They are stored in three places.

## Claims being made
- /privacy: "We do not store the prompts or completions of jobs you submit"; /faq: "The control plane stores job metadata ... but not prompt content."
- /privacy: "You can delete your account at any time from the dashboard"; subprocessor "Railway: application hosting".
- README: node specs are coarse and privacy-preserving; E2E encryption (NIP-44); jobs sandboxed in Docker; secret detection.
- ARCHITECTURE.md says the CLI holds a Supabase service-role key.

## Current state (evidence)
- Prompts in `jobs.input_spec`, every streamed token in `job_events.data` (143,899 rows), final text in `jobs.result`. Encrypted only if `INFERNET_DB_ENCRYPTION_KEY` is set (it is in prod), and the server holds the key.
- No delete-account route or UI in `apps/web`.
- Hosting is dev2 (nginx), not Railway; `/api/health` reads `RAILWAY_GIT_COMMIT_SHA` so `commit` is null.
- Heartbeat specs are stored unsanitized: `patch.specs = body.specs` (`node-api.js:236`), while register sanitizes.
- NIP-44 covers the prompt only; responses return in plaintext.
- No TEE, no Docker sandbox for jobs, secret-detection module unused.

## Requirements
1. **Now:** rewrite /privacy and /faq to match reality (stored encrypted at rest, retention period, who can decrypt), or change the code to match the policy. Recommended: add a retention job that deletes `job_events` and `input_spec`/`result` after 7 days, then state that.
2. Delete-account flow (dashboard + `DELETE /api/v1/user`), cascading pubkey links and jobs.
3. Update subprocessors; make `/api/health` report the deployed commit.
4. Sanitize heartbeat specs with the same function as register.
5. E2E for responses (encrypt tokens to the client pubkey) or narrow the claim to "prompts".
6. Remove TEE/sandbox/secret-detection claims until built; fix ARCHITECTURE.md.

## Acceptance criteria
- A privacy-claims checklist in this PRD is reviewed against code in CI docs review; every statement has a code reference.
- A deleted account leaves no rows referencing its user id.
