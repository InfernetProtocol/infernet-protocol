# Infernet provider image — boots the `infernet` CLI as a provider node.
#
# Built directly from the git checkout via pnpm deploy — no npm registry
# dependency. The release pipeline (.github/workflows/release.yml) uses
# the repo root as the build context so workspace dependencies resolve.
#
# Required env at runtime:
#   SUPABASE_URL
#   SUPABASE_SERVICE_ROLE_KEY
#   INFERNET_NODE_NAME               (defaults to hostname)
#   INFERNET_NODE_ROLE               (defaults to 'provider')
#   INFERNET_P2P_PORT                (defaults to 46337)

# ---------------------------------------------------------------------------
# Build stage — install workspace deps + produce a self-contained CLI deploy.
# ---------------------------------------------------------------------------
FROM node:lts-slim AS builder

RUN npm install --global pnpm@10.6.5

WORKDIR /build
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages ./packages
COPY apps/cli ./apps/cli

# Install only the dep cone the CLI needs.
RUN pnpm install --frozen-lockfile --filter @infernetprotocol/cli...

# `pnpm deploy` materializes the workspace deps into a single self-contained
# tree under /out so the runtime image doesn't need pnpm or workspace plumbing.
# --legacy is required in pnpm v10 for workspaces that don't set
# inject-workspace-packages=true (which we don't).
RUN pnpm --filter @infernetprotocol/cli deploy --legacy --prod /out

# ---------------------------------------------------------------------------
# Runtime stage — minimal.
# ---------------------------------------------------------------------------
FROM node:lts-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    tini \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /out /app
RUN chmod +x /app/index.js && ln -s /app/index.js /usr/local/bin/infernet

COPY tooling/docker/provider/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 46337/tcp
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
