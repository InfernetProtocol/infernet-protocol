-- Consumer credit codes + scarce invites (fleet rollout, 2026-10-26).
--
-- The two migrations before this one are the packages' own migrations/supabase.sql,
-- verbatim: @profullstack/redeem-credits (credit_* tables) and @profullstack/affiliates
-- (aff_* tables). Both enable RLS with no policies, revoke everything from anon and
-- authenticated, and make their SECURITY DEFINER functions executable by service_role only.
--
-- credit_ledger (unit 'credits') is the CONSUMER credit balance of a signed-in account.
-- It is deliberately separate from provider_earnings / payout_requests: nothing in
-- lib/data/earnings.js reads it, and nothing can withdraw it. A code or an invite bonus
-- therefore never becomes provider earnings or anything that can be paid out.

-- One bonus decision per (invite, side). Claimed before the grant, so retries and races
-- never pay twice; a 'denied' row records why (same mailbox, throwaway domain, cap...).
CREATE TABLE IF NOT EXISTS public.invite_bonuses (
  invite_id  TEXT NOT NULL,
  side       TEXT NOT NULL CHECK (side IN ('inviter', 'invitee')),
  user_id    TEXT NOT NULL,
  outcome    TEXT NOT NULL CHECK (outcome IN ('granted', 'denied')),
  reason     TEXT,
  credits    DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (invite_id, side)
);
CREATE INDEX IF NOT EXISTS invite_bonuses_user_idx ON public.invite_bonuses (user_id, side, created_at);

ALTER TABLE public.invite_bonuses ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.invite_bonuses FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.invite_bonuses TO service_role;

-- Grant once per (user, source): an invite bonus source (invite:<id>:<side>) can land in
-- the ledger once per account, whatever the caller does.
CREATE UNIQUE INDEX IF NOT EXISTS credit_ledger_invite_once
  ON public.credit_ledger (user_id, source)
  WHERE kind = 'grant' AND source LIKE 'invite:%';

-- Hygiene found during the rollout audit: rls_auto_enable() is SECURITY DEFINER and
-- carried the default PUBLIC execute. It returns event_trigger, so it cannot be called
-- through PostgREST, but no API role needs it.
DO $$
BEGIN
  IF to_regprocedure('public.rls_auto_enable()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon, authenticated;
  END IF;
END $$;
