import "server-only";
import { refFromRequest } from "@profullstack/affiliates";
import { cookieFrom } from "@/lib/auth/request-user";
import { onSignedIn } from "@/lib/credits";
import { INVITE_COOKIE, looksLikeCode } from "@/lib/credits/core";
import { attributeUser } from "@/lib/data/referrals";

/**
 * Spend referrals: a referral code (?ref= / /r/<code>, first touch) seen at a
 * NEW account's first sign-in makes its owner this person's referrer.
 * attributeUser refuses anything else (old account, already charged, self,
 * house). Never throws.
 */
export async function attributeSpendReferral(user, refCode, via, ip = null) {
    try {
        const out = await attributeUser({ userId: user.id, code: refCode, via, ip, accountCreatedAt: user.created_at ?? null });
        if (out?.attributed && !out.already) console.log(`[referrals] person attributed via ${via}`);
        return out;
    } catch (err) {
        console.error("[referrals] person attribution failed", err?.message ?? err);
        return null;
    }
}

/**
 * Called by every sign-in path (email confirmation / magic link callback,
 * password login). The invite code comes from the /i/<code> cookie, else the
 * one stored in user_metadata at signup (so another browser still counts);
 * ?ref= from the query / referral_code cookie, else user_metadata. Never throws.
 */
export async function afterSignIn(request, user) {
    if (!user?.id) return null;
    try {
        const meta = user.user_metadata ?? {};
        const inviteCode = [cookieFrom(request, INVITE_COOKIE), meta.invite_code].find((c) => looksLikeCode(c)) ?? null;
        const refCode = refFromRequest(request) ?? (typeof meta.ref_code === "string" ? meta.ref_code : null);
        if (refCode) await attributeSpendReferral(user, refCode, "infernet-signin");
        return await onSignedIn(user.id, { inviteCode, refCode });
    } catch (err) {
        console.error("[invites] afterSignIn failed", err?.message ?? err);
        return null;
    }
}
