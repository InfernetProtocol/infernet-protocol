# Self-Hosting the Control Plane

The Infernet control plane is open source. You can run your own instance for:

- **Full data sovereignty**: inference requests and job history stay on your infrastructure
- **Private networks**: run a closed network of nodes and clients within your organization
- **Custom pricing**: set your own rates rather than using the public network's rates
- **Development**: test protocol changes against a local control plane

## What the Control Plane Is

The control plane is a Next.js application that runs on Node.js. It uses Supabase (Postgres + Realtime + Auth) for persistence and real-time features. The entire stack can be self-hosted.

Components:
```
control-plane/
├── Next.js app         (API routes + dashboard UI)
├── Supabase project    (Postgres + Realtime + Storage)
└── Signing keys        (platform keypair for CPR countersignatures)
```

## Prerequisites

- Node.js 20+
- Docker (for running Supabase locally)
- A server with a public IP (or domain) for nodes to reach

## Option 1: Supabase Cloud + Deployed Next.js

This is the easiest path. Use Supabase's hosted service for the database and deploy the Next.js app to Vercel, Railway, or any Node.js host.

### Set Up Supabase

1. Create a project at [supabase.com](https://supabase.com)
2. Note your project URL and anon key
3. Run the Infernet schema migrations:

```bash
git clone https://github.com/InfernetProtocol/infernet-protocol
cd infernet/control-plane

# Install Supabase CLI
npm install -g supabase

# Link to your project
supabase link --project-ref your-project-ref

# Run migrations
supabase db push
```

### Deploy the Next.js App

```bash
cd infernet/control-plane

# Install dependencies
npm install

# Set environment variables
cp .env.example .env.local
```

Required env vars in `.env.local`:

```bash
# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Platform signing key (generate with: infernet keys generate-platform)
PLATFORM_SIGNING_KEY=your-platform-private-key-hex

# App URL
NEXT_PUBLIC_APP_URL=https://your-control-plane.example.com

# Optional: restrict to invited users only
REQUIRE_INVITE=true
```

Generate the platform signing key:

```bash
infernet keys generate-platform
# Platform private key: (hex) — save this securely
# Platform public key:  (hex) — register this on-chain if using payments
```

Deploy to Vercel:

```bash
npm run build
vercel deploy --prod
```

Or to Railway:

```bash
railway up
```

## Option 2: Fully Self-Hosted (Supabase Local)

For maximum control, run Supabase locally with Docker.

```bash
# Start Supabase
cd infernet/control-plane
supabase start

# This starts: Postgres, Studio, Auth, Realtime, Storage
# Outputs: API URL and keys for your local instance
```

The local Supabase dashboard is at `http://localhost:54323`.

Configure `.env.local` with the local URLs from `supabase start` output, then run the Next.js app:

```bash
npm run dev
# Control plane running at http://localhost:3000
```

For production local deployment, build and run with pm2 or a process manager:

```bash
npm run build
pm2 start npm --name infernet-cp -- start
```

## Pointing the CLI at Your Control Plane

After setting up the control plane, configure the CLI to use it:

```bash
# During setup
infernet setup --control-plane https://your-control-plane.example.com

# Or update config directly
infernet config set control_plane_url https://your-control-plane.example.com

# Restart daemon
infernet service restart
```

Or edit `~/.infernet/config.json`:

```json
{
  "control_plane_url": "https://your-control-plane.example.com"
}
```

Verify the connection:

```bash
infernet doctor
# Should show: [OK] Control plane: reachable (your-control-plane.example.com)
```

## Creating the First Admin Account

On a fresh control plane, you need to create the first admin account manually via the Supabase dashboard or directly in the database:

```sql
-- In Supabase SQL editor
INSERT INTO profiles (id, email, role)
VALUES (
  auth.uid(),  -- After creating via Supabase Auth
  'admin@yourdomain.com',
  'admin'
);
```

Or use the Supabase dashboard: **Authentication → Users → Invite user**.

## Private Network Configuration

For a fully private network where only your nodes participate:

```bash
# Disable public node registration
# In .env.local:
REQUIRE_NODE_APPROVAL=true

# Nodes will need manual approval via dashboard
# Settings → Nodes → Pending Approval
```

Client API tokens are issued from the dashboard. For a private network, issue tokens only to your authorized clients.

## Payment Setup for Self-Hosted

If you want payments on your self-hosted network:

1. Deploy the payment contracts to your chosen chain (contracts in `infernet/contracts/`)
2. Set the contract addresses in your control plane config:

```bash
# .env.local
PAYMENT_CONTRACT_BASE=0x...
PAYMENT_CONTRACT_ETHEREUM=0x...
PLATFORM_SIGNING_KEY=0x...  # Must match what's registered in the contract
```

For a purely private internal network where you don't need crypto payments, you can disable the payment system entirely:

```bash
PAYMENTS_ENABLED=false
```

In this mode, jobs are tracked but no escrow or CPR logic runs.

## Upgrading

```bash
git pull origin main
cd infernet/control-plane
npm install
supabase db push  # Apply new migrations
npm run build
pm2 restart infernet-cp
```

Check the changelog for breaking migrations before upgrading.
