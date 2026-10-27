import OrderStatus from "./order-status";

export const dynamic = "force-dynamic";
export const metadata = { title: "Your order — Infernet Protocol", robots: { index: false } };

export default async function OrderStatusPage({ params }) {
    const { id } = await params;
    return <OrderStatus id={id} />;
}
