import OrderView from "./order-view";

export const dynamic = "force-dynamic";

export const metadata = {
    title: "Order a GPU endpoint — Infernet Protocol",
    description:
        "Book a dedicated model endpoint on an online Infernet node by the hour. Pay with any coin CoinPay takes, PayPal, or x402 (USDC). No account needed."
};

export default function OrderPage() {
    return <OrderView />;
}
