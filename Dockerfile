# syntax=docker/dockerfile:1
# FoxTrot API — single-container image for Elastic Beanstalk (Docker platform).
#
#   docker build -t foxtrot-api:dev .
#   docker run -p 3001:3001 --env-file apps/api/.env foxtrot-api:dev
#
# node:20-slim (Debian bookworm) — Prisma 5 ships engines for
# debian-openssl-3.0.x; alpine/musl is deliberately avoided.

############################################################
# Stage 1: build — full workspace install, compile, generate
############################################################
FROM node:20-slim AS build
WORKDIR /app

# Prisma engines want OpenSSL present even at generate time.
RUN apt-get update -y \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

# Manifests only → the npm ci layer caches until a dependency changes.
# Every workspace package.json must be present for a workspace-aware ci.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN npm ci

# Sources (the web app is not built here — it deploys to S3/CloudFront).
COPY prisma ./prisma
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api

# Prisma client (schema lives at the repo root: prisma/schema.prisma).
RUN npx prisma generate

# Build order matters: the api imports @foxtrot/shared from its dist/.
RUN npm run build -w packages/shared \
    && npm run build -w apps/api

############################################################
# Stage 2: proddeps — production-only node_modules from the lockfile
############################################################
FROM node:20-slim AS proddeps
WORKDIR /app

# openssl must be present BEFORE npm ci: the @prisma/engines postinstall
# detects the platform to pick an engine build, and without openssl it
# falls back to debian-openssl-1.1.x — which then fails on the (openssl 3)
# runtime image.
RUN apt-get update -y \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
# Note: the prisma CLI survives --omit=dev (it is devOptional in the
# lockfile: devDependency of apps/api + optional peer of @prisma/client).
# The runtime entrypoint relies on it for `migrate deploy`; the engine
# check in the runtime stage below fails the build if it ever disappears.
RUN npm ci --omit=dev

############################################################
# Stage 3: runtime
############################################################
FROM node:20-slim AS runtime
ENV NODE_ENV=production
# Disable prisma CLI update-check/telemetry phone-home at container start.
ENV CHECKPOINT_DISABLE=1
WORKDIR /app

# openssl: required by the Prisma query/migrate engines on slim images.
# ca-certificates: system trust store for the engines' TLS connections.
RUN apt-get update -y \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Production node_modules (workspace symlinks intact), then overlay the
# generated Prisma client from the build stage — `npm ci --omit=dev` cannot
# generate it (the prisma CLI is a devDependency).
COPY --from=proddeps /app/node_modules ./node_modules
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma/client ./node_modules/@prisma/client

# Manifests (Node resolves workspaces through these + the symlinks above).
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/

# Built artifacts.
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/apps/api/dist ./apps/api/dist

# Schema (+ migrations once the baseline lands) for boot-time migrate deploy.
COPY prisma ./prisma

# Ensure the prisma CLI works and its engines for THIS platform are baked
# into the image now, as root — the runtime user must never need to write
# into node_modules (engine downloads at container start would EACCES and,
# worse, depend on the network). Fails the build loudly if the CLI is
# missing or the engines mismatch.
RUN npx prisma --version

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# CRLF guard: the script may be checked out with Windows line endings.
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
    && chmod +x /usr/local/bin/docker-entrypoint.sh

# Local-disk replay fallback target (unused when S3_BUCKET is set, but keeps
# the image functional without S3). Four levels up from dist/lib = /app.
RUN mkdir -p /app/storage/replays && chown -R node:node /app/storage

USER node

ENV PORT=3001
# API (Fastify). Socket.io currently binds PORT+1 (3002) in this revision;
# it is being consolidated onto PORT — drop 3002 once that lands.
EXPOSE 3001
EXPOSE 3002

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "apps/api/dist/index.js"]
