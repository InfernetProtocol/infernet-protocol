# syntax=docker/dockerfile:1.7-labs
#
# Production image for the Infernet control plane (apps/web).
#
# Multi-stage build that preserves pnpm's workspace topology end-to-end.
# Workspace manifests are copied via BuildKit's `COPY --parents` glob
# so adding a new packages/* member doesn't require a Dockerfile edit
# (and we never recreate the bug where a missing manifest hung
# `pnpm install --frozen-lockfile` for an hour on Railway).

# ---------------------------------------------------------------------------
# Base — corepack-managed pnpm so the version is pinned & reproducible.
# ---------------------------------------------------------------------------
FROM node:lts-alpine AS base
WORKDIR /app
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.6.5 --activate

# ---------------------------------------------------------------------------
# Deps — install everything @infernetprotocol/web's dep cone needs.
#
# pnpm needs to see the WHOLE workspace topology (workspace yaml +
# every member package.json) to resolve `workspace:*` references,
# even when filtering. We copy manifests + lockfile only at this
# stage so we don't bust the layer cache on every source-code change.
# ---------------------------------------------------------------------------
FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./

# Every workspace member's package.json, in one shot, with directory
# structure preserved (`--parents` is a BuildKit feature — see syntax
# directive at the top). Source-code changes in apps/*/src or
# packages/*/src do NOT bust this layer's cache because we only pull
# in package.json files here. New workspace members are picked up
# automatically.
COPY --parents apps/*/package.json packages/*/package.json ./

# Only install what apps/web needs (and its workspace deps).
RUN pnpm install --frozen-lockfile --filter @infernetprotocol/web...

# ---------------------------------------------------------------------------
# Builder — copy installed node_modules + source, run next build.
# ---------------------------------------------------------------------------
FROM base AS builder

# Bring in the installed workspace from the deps stage (preserves
# pnpm's symlink topology under /app/node_modules and
# /app/apps/web/node_modules).
COPY --from=deps /app /app

# Now copy the source over the manifests we already used.
COPY apps/web      ./apps/web
COPY packages      ./packages

# The canonical installer lives at the repo root; apps/web's prebuild
# (scripts/sync-install-sh.mjs) generates apps/web/public/install.sh from it,
# so the builder needs it on disk before `next build`. The generated public
# copy then flows into the production image via the apps/web COPY above.
COPY install.sh    ./install.sh

RUN pnpm --filter @infernetprotocol/web build

# ---------------------------------------------------------------------------
# Production — runs on Bun.
#
# pnpm stays the monorepo's package manager and Next builds on Node above:
# the CLI, daemon, desktop and mobile apps and the npm release depend on
# pnpm. What runs in production is `next start` for apps/web, and that runs
# on Bun: alpine:3.24 (the Alpine node:lts-alpine is on) with Bun's musl
# binary copied in, Next's own entry file run by Bun as one process.
# The workspace tree is kept intact as before (non-standalone), so request-
# time reads such as public/install.sh resolve exactly as they did.
# ---------------------------------------------------------------------------
FROM oven/bun:1.4.0-alpine AS bun

FROM alpine:3.24 AS production
RUN apk add --no-cache libstdc++ libgcc ca-certificates
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN addgroup -S -g 1000 bun && adduser -S -D -u 1000 -G bun -h /home/bun bun
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    HOSTNAME=0.0.0.0

COPY --from=builder --chown=bun:bun /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=builder --chown=bun:bun /app/pnpm-lock.yaml      ./pnpm-lock.yaml
COPY --from=builder --chown=bun:bun /app/package.json        ./package.json
COPY --from=builder --chown=bun:bun /app/apps/web            ./apps/web
COPY --from=builder --chown=bun:bun /app/packages            ./packages
COPY --from=builder --chown=bun:bun /app/node_modules        ./node_modules

USER bun
EXPOSE 8080

# `next start` in /app/apps/web, as `pnpm --filter @infernetprotocol/web start`
# did, with Next's entry file run directly by Bun.
WORKDIR /app/apps/web
CMD ["bun", "--bun", "node_modules/next/dist/bin/next", "start"]
