/**
 * The auth email of an account a first "Sign in with CoinPay" created: a
 * random address under our own domain that nobody receives mail at. Supabase
 * holds it as confirmed (a magic-link session needs that); everything else
 * must treat it as no address at all (no mail, no invite bonus, no admin).
 */
export const PLACEHOLDER_EMAIL_DOMAIN = "coinpay-users.infernetprotocol.com";

export function isPlaceholderEmail(email) {
    return typeof email === "string" && email.toLowerCase().endsWith("@" + PLACEHOLDER_EMAIL_DOMAIN);
}
