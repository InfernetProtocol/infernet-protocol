import AdminOrderPricing from "@/components/admin-order-pricing";

export const metadata = {
    title: "Order pricing",
    robots: { index: false, follow: false }
};
export const dynamic = "force-dynamic";

/** Admin knob: the minimum profit margin self-serve orders sell at over our cost. */
export default function AdminPricingPage() {
    return (
        <main className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 lg:px-10">
            <header className="mb-8">
                <p className="text-xs font-semibold uppercase tracking-[0.4em] text-[var(--accent)]">Admin</p>
                <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white">Order pricing</h1>
                <p className="mt-2 text-sm text-[var(--muted)]">
                    Self-serve orders at /order are priced from what the GPU costs us, plus this margin.
                </p>
            </header>
            <AdminOrderPricing />
        </main>
    );
}
