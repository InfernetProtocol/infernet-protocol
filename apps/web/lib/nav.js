// The site's information architecture: every public page sits in one of a few
// top-level groups. The header renders these as dropdown panels on desktop and
// as one grouped full-screen menu on phones (components/site-header.js).
// Every URL the old flat navbar linked is still here.

export const GITHUB_URL = "https://github.com/infernetprotocol/infernet-protocol";

/** Shown as its own top-level link, outside the groups. */
export const FEATURED = { href: "/gallery", label: "Gallery", hint: "What people built on Infernet and c0mpute" };

export const NAV_GROUPS = [
    {
        id: "use",
        label: "Use",
        items: [
            { href: "/chat", label: "Chat", hint: "Open models on the network, in your browser" },
            { href: "/gallery", label: "Gallery", hint: "Apps and sites built on Infernet" },
            { href: "/order", label: "Order GPUs", hint: "Reserve a GPU endpoint by the hour" },
            { href: "/deploy", label: "Deploy a GPU", hint: "One-click launch on your own cloud key" },
            { href: "/pricing", label: "Models & pricing", hint: "Every model and what it costs" }
        ]
    },
    {
        id: "providers",
        label: "Providers",
        items: [
            { href: "/getting-started", label: "Run a node", hint: "Install the CLI and start earning" },
            { href: "/docs#earnings", label: "Earnings", hint: "How serving jobs pays you" },
            { href: "/docs#cli-payout", label: "Payouts", hint: "Withdraw to your wallet" },
            { href: "/refer", label: "Refer a node", hint: "A share of the house fee on nodes you bring in" },
            { href: "/gpu", label: "GPU fleet", hint: "Every GPU model on the network" },
            { href: "/cpu", label: "CPU fleet", hint: "Every CPU class on the network" },
            { href: "/status", label: "Network status", hint: "Live nodes, models and jobs" }
        ]
    },
    {
        id: "developers",
        label: "Developers",
        items: [
            { href: "/docs", label: "Docs", hint: "Quick start and reference" },
            { href: "/docs#api", label: "API", hint: "OpenAI-compatible endpoints and keys" },
            { href: "/docs#cli-overview", label: "CLI", hint: "The infernet command" },
            { href: "/docs/managed-endpoints#api", label: "MCP", hint: "infernet mcp for agents" },
            { href: "/docs/batch-inference", label: "Batch inference", hint: "Paid jobs at volume" },
            { href: "/docs/house-models", label: "House models", hint: "What every node serves" },
            { href: "/book", label: "Book", hint: "The operator and developer guide" },
            { href: "/protocol", label: "Protocol", hint: "How the network works" },
            { href: GITHUB_URL, label: "GitHub", hint: "Source, MIT licensed", external: true }
        ]
    },
    {
        id: "company",
        label: "Company",
        items: [
            { href: "/pricing", label: "Pricing", hint: "Models and rates" },
            { href: "/status", label: "Status", hint: "Is the network up" },
            { href: "/protocol", label: "About", hint: "Why Infernet exists" },
            { href: "/faq", label: "FAQ", hint: "Common questions" },
            { href: "/careers", label: "Careers", hint: "Open roles" },
            { href: "/contact", label: "Contact", hint: "Talk to the team" }
        ]
    }
];

/** Added for signed-in visitors. */
export const ACCOUNT_GROUP = {
    id: "account",
    label: "Account",
    items: [
        { href: "/dashboard", label: "Dashboard", hint: "Your nodes and jobs" },
        { href: "/dashboard/earnings", label: "Earnings", hint: "What your nodes earned" },
        { href: "/dashboard/billing", label: "Billing & API keys", hint: "Balance, top-ups and keys" },
        { href: "/invites", label: "Invites", hint: "Invite codes and credits" },
        { href: "/refer", label: "Refer a node", hint: "Your referral link and commissions" },
        { href: "/settings", label: "Settings", hint: "Your account" }
    ]
};

export function navGroups(user) {
    return user ? [...NAV_GROUPS, ACCOUNT_GROUP] : NAV_GROUPS;
}
