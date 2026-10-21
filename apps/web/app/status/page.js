import DashboardShell from "@/components/dashboard-shell";
import OverviewGrid from "@/components/overview-grid";
import ResourceTable from "@/components/resource-table";
import RealtimeRefresh from "@/components/realtime-refresh";
import {
  getAggregators,
  getClients,
  getDashboardOverview,
  getJobs,
  getStatusProviders,
  getServedModelsAcrossProviders
} from "@/lib/data/infernet";

export const dynamic = "force-dynamic";

async function fetchLatestCliVersion() {
  try {
    const res = await fetch(
      "https://api.github.com/repos/infernetprotocol/infernet-protocol/releases/latest",
      { headers: { accept: "application/vnd.github+json", "user-agent": "infernet-web" }, next: { revalidate: 300 } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data.tag_name === "string" ? data.tag_name : null;
  } catch {
    return null;
  }
}

export default async function HomePage() {
  const [overview, jobs, providers, models, clients, aggregators, latestCli] = await Promise.all([
    getDashboardOverview(),
    getJobs({ limit: 6 }),
    getStatusProviders({ limit: 12 }),
    getServedModelsAcrossProviders(),
    getClients({ limit: 6 }),
    getAggregators({ limit: 6 }),
    fetchLatestCliVersion()
  ]);

  return (
    <>
    <DashboardShell
      eyebrow="Network status"
      title="Infernet network status"
      description="Live snapshot of nodes, jobs, providers, models, clients, and aggregators on the network."
    >
      <div className="flex items-center justify-between">
        {latestCli && (
          <span className="text-xs text-[var(--muted)]">
            Latest CLI: <span className="font-mono text-white">{latestCli}</span>
          </span>
        )}
        <RealtimeRefresh tables={["providers", "aggregators", "jobs"]} />
      </div>
      <OverviewGrid cards={overview.cards} />
      <div className="grid gap-6 xl:grid-cols-2">
        <ResourceTable
          title="Queued jobs"
          description="Jobs in the queue right now."
          columns={[
            { key: "title", label: "Job" },
            { key: "status", label: "Status" },
            { key: "model_name", label: "Model" },
            { key: "payment_offer", label: "Offer" }
          ]}
          rows={jobs}
          emptyMessage="No jobs found."
        />
        <ResourceTable
          title="Providers"
          description="Online first, then most recently seen. Click a provider for its location, hardware, models and jobs. Verified = aggregators that reached it in the last hour."
          columns={[
            { key: "name", label: "Provider", hrefKey: "href" },
            { key: "status", label: "Status" },
            { key: "location", label: "Location" },
            { key: "last_seen", label: "Last seen" },
            { key: "verified", label: "Verified" },
            { key: "gpu_summary", label: "GPU" },
            { key: "cli_version", label: "Version" }
          ]}
          rows={providers}
          emptyMessage="No providers found."
        />
        <ResourceTable
          title="Models served"
          description="Models live providers are advertising right now."
          columns={[
            { key: "name", label: "Model" },
            { key: "providers", label: "Providers" },
            { key: "freshest_seen", label: "Last heartbeat" }
          ]}
          rows={models}
          emptyMessage="No models advertised. Online providers haven't sent a fresh specs.served_models yet."
        />
        <ResourceTable
          title="Clients"
          description="Clients using the control plane."
          columns={[
            { key: "name", label: "Client" },
            { key: "status", label: "Status" },
            { key: "budget_usd", label: "Budget" }
          ]}
          rows={clients}
          emptyMessage="No clients found."
        />
        <ResourceTable
          title="Aggregators"
          description="Independent nodes that dial every provider each minute and report which ones are really reachable. Run one with: infernet init --role aggregator, then infernet setup --yes."
          columns={[
            { key: "name", label: "Aggregator", hrefKey: "href" },
            { key: "status", label: "Status" },
            { key: "location", label: "Location" },
            { key: "last_seen", label: "Last seen" },
            { key: "probed", label: "Last hour" }
          ]}
          rows={aggregators}
          emptyMessage="No aggregators yet."
        />
      </div>
    </DashboardShell>
    </>
  );
}
