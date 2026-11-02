import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentUser } from "@/lib/supabase/auth-server";
import BillingPanel from "@/components/billing-panel";

export const dynamic = "force-dynamic";
export const metadata = { title: "Billing and API keys — Infernet" };

/**
 * Paid batch inference for the signed-in user: what they can spend (node
 * earnings first, then prepaid), top-ups, API keys and recent batches.
 * The panel talks to the same /api/v1 routes as the CLI and MCP tools.
 */
export default async function BillingPage() {
    const user = await getCurrentUser();
    if (!user) redirect("/auth/login?next=/dashboard/billing");
    return (
        <main className="mx-auto w-full max-w-5xl space-y-6 px-4 py-8">
            <div className="flex items-center justify-between gap-3">
                <h1 className="text-2xl font-semibold text-white">Billing and API keys</h1>
                <Link href="/dashboard" className="text-sm text-[var(--accent)] hover:underline">Back to dashboard</Link>
            </div>
            <p className="text-sm text-[var(--muted)]">
                Paid batch inference spends your confirmed node earnings first (Infernet and c0mpute nodes are one balance,
                no fee to move it), then your prepaid balance. If both run short, a batch can pay the rest from a CoinPay
                wallet at submit. Token counts are server-side estimates, never what a node reports.{" "}
                <Link href="/docs/batch-inference" className="text-[var(--accent)] hover:underline">How it works</Link>
            </p>
            <BillingPanel />
        </main>
    );
}
