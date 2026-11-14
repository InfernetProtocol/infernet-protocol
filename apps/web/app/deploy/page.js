import { redirect } from "next/navigation";
import DeployView from "./deploy-view";
import { getCurrentUser } from "@/lib/supabase/auth-server";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Deploy a GPU — Infernet Protocol",
  description:
    "Launch an Infernet provider node on a rented cloud GPU (Vast.ai, RunPod, Vultr, Linode, Scaleway, DigitalOcean) in one click. No SSH, no package managers — your pod boots, registers, and starts earning."
};

export default async function DeployPage() {
  // Gate the page server-side. The mint endpoint already requires a
  // valid session, but the UI used to render the "Mint" button even
  // when SiteHeader believed the user was logged out — confusing
  // because the cookie was actually still alive (middleware silently
  // refreshes it). Redirect at the page level so what the user sees
  // and what the server sees stay in sync.
  const user = await getCurrentUser().catch(() => null);
  if (!user) {
    redirect("/auth/login?next=/deploy");
  }
  return <DeployView signedInAs={user.email ?? user.id} />;
}
