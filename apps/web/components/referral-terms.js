/**
 * The public node-referral terms, rendered from live config (referralTerms()
 * in lib/referrals/core.js) so the page never states a number the ledger does
 * not use. `terms.term` is the reader's own commission term, when signed in.
 */
function usd(n) {
    const v = Number(n) || 0;
    return v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(2).replace(/\.?0+$/, "") || "0"}`;
}

export default function ReferralTerms({ terms, site = "Infernet" }) {
    const pct = terms?.commission_pct_of_house_fee ?? 5;
    const fee = terms?.house_fee_pct;
    const eff = terms?.effective_pct_of_node_revenue;
    return (
        <section id="terms" className="rounded-[1.5rem] border border-white/10 bg-[var(--panel)] p-6 text-sm leading-6 text-[var(--muted)]">
            <h2 className="text-lg font-semibold text-white">Referral terms</h2>
            <ul className="mt-3 list-disc space-y-2 pl-5">
                <li>
                    You earn <strong className="text-white">{pct}% of the house fee</strong> {site} earns on each paid job served by a node
                    you referred.{fee != null ? ` With today's ${fee}% house fee that is about ${eff}% of what that node's jobs bring in.` : ""}
                </li>
                <li>
                    The commission comes out of the house fee. It is never taken from the node operator's earnings, and it is never more
                    than the house earned on that job. Jobs that earn the house no fee (free tier, subsidised or unpaid jobs) earn no
                    commission.
                </li>
                {terms?.term ? (
                    <li>
                        <strong className="text-white">Your commission term:</strong> {terms.term.label}
                        {terms.term.months ? ` (${terms.term.months} months)` : ""}. It was set when your link was created and does not change.
                    </li>
                ) : (
                    <li>Each referrer's commission term is set once, when their link is created, and is shown on their referral page.</li>
                )}
                <li>
                    A node counts as referred when it registers with a referral code, before its first paid job. Each node has one referrer,
                    and that cannot be changed later.
                </li>
                <li>
                    No self-referral: nodes you operate, nodes that share your payout wallet or your network, and jobs you pay for yourself
                    earn no commission. Commissions from self-referral or abuse may be voided.
                </li>
                <li>
                    A commission is confirmed when its job's payment is confirmed. Payouts use the same path as node earnings: minimum{" "}
                    {usd(terms?.min_payout_usd)}, requests up to {usd(terms?.auto_approve_max_usd)} are sent automatically through CoinPay,
                    larger ones are reviewed first.
                </li>
                <li>
                    Payouts may require tax information. US referrers may receive a Form 1099 once their payments reach the IRS reporting
                    threshold, the same as node payouts.
                </li>
                <li>
                    The rate can change for future jobs; a commission already earned keeps the rate it was earned at. Nothing here promises
                    any amount of income.
                </li>
            </ul>
        </section>
    );
}
