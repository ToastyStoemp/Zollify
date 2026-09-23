# Build from the repo root:
#   docker build -f apps/server/Dockerfile -t zollify .
#
# Unlike ZollTool, the web build happens here rather than being committed as a
# zip. Zollify has to build the module bundles anyway - their hashes are what
# the client verifies - so having the build in one reproducible place is worth
# more than shaving minutes off a deploy. On a small instance this is slow; see
# deploy.sh for building elsewhere and shipping the image.

# ── deps ────────────────────────────────────────────────────────────────────
# Package manifests only, so this layer is reused whenever sources change but
# dependencies do not.
FROM node:22-bookworm-slim AS deps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/sdk/package.json packages/sdk/
COPY packages/shared/package.json packages/shared/
COPY packages/platform/package.json packages/platform/
COPY packages/server-core/package.json packages/server-core/
COPY packages/ui/package.json packages/ui/
COPY modules/pos/package.json modules/pos/
COPY modules/customs-ch/package.json modules/customs-ch/
COPY modules/customs-de/package.json modules/customs-de/
COPY modules/sourcing/package.json modules/sourcing/
COPY modules/shopify-sync/package.json modules/shopify-sync/
COPY modules/price-cards/package.json modules/price-cards/
COPY modules/label-printer/package.json modules/label-printer/
COPY modules/convention-checklist/package.json modules/convention-checklist/
COPY modules/migration/package.json modules/migration/
COPY apps/web/package.json apps/web/
COPY apps/server/package.json apps/server/
RUN --mount=type=cache,target=/root/.npm npm ci

# ── build ───────────────────────────────────────────────────────────────────
FROM deps AS build
WORKDIR /repo
# .dockerignore excludes .git from the build context entirely (line 7), so
# `git rev-parse` inside this stage always fails silently - both
# apps/web/vite.config.ts's buildStamp() and publish-shell.mjs fell back to a
# bare "0.1.0" on every single Docker build, identical every time. Since
# publish-shell.mjs treats a version's directory as immutable (skips if it
# already exists), that meant exactly ONE successful publish ever, on
# whichever commit first built this Dockerfile - every deploy since silently
# no-op'd, and latest.json never moved again. Passed through the same way
# the runtime stage already stamps ZOLLIFY_COMMIT_SHA for Server admin -
# docker.yml already sends --build-arg ZOLLIFY_COMMIT=${{ github.sha }}, it
# just never reached this stage before.
ARG ZOLLIFY_COMMIT=unknown
ENV ZOLLIFY_COMMIT=$ZOLLIFY_COMMIT
COPY . .
RUN npm run build -w @zollify/web
# Publishes each module bundle plus its manifest and SHA-256 into the store the
# gateway serves from.
RUN node scripts/publish-modules.mjs
# Zips the just-built apps/web/dist into the content-update store
# @capgo/capacitor-updater's clients fetch from - ZOLLIFY_SKIP_BUILD since
# apps/web was already built by the line above.
RUN ZOLLIFY_SKIP_BUILD=1 node scripts/publish-shell.mjs

# ── runtime ─────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
WORKDIR /repo

# The commit being shipped, stamped by the image workflow so Server admin can show it.
ARG ZOLLIFY_COMMIT=unknown
ENV ZOLLIFY_COMMIT_SHA=$ZOLLIFY_COMMIT

ENV NODE_ENV=production \
    ZOLLIFY_DATA_DIR=/data \
    ZOLLIFY_MODULE_STORE=/repo/apps/server/modules-store \
    ZOLLIFY_WEB_DIST=/repo/apps/web/dist \
    ZOLLIFY_APK_DIR=/data/apk \
    ZOLLIFY_SHELL_STORE=/repo/apps/server/shell-store \
    ZOLLIFY_DEPLOY_DIR=/data/deploy \
    PORT=8787 \
    HOST=0.0.0.0

# Production dependencies only. The build stage's devDependencies (vite, vue-tsc)
# have no business in the running image.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server-core/package.json packages/server-core/
COPY apps/server/package.json apps/server/
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev -w @zollify/server -w @zollify/server-core -w @zollify/shared

COPY packages/shared packages/shared
COPY packages/server-core packages/server-core
COPY apps/server/src apps/server/src
COPY apps/server/tsconfig.json apps/server/

# Built artefacts from the build stage - sources for these are not shipped.
COPY --from=build /repo/apps/web/dist apps/web/dist
COPY --from=build /repo/apps/server/modules-store apps/server/modules-store
COPY --from=build /repo/apps/server/shell-store apps/server/shell-store

# Drop privileges. The node image ships an unprivileged `node` user. /data is
# created here, owned by it, so a fresh named volume inherits that ownership
# instead of coming up root-owned and unwritable.
RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 8787
VOLUME /data

# The gateway answers /health without auth, which is what this checks.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node_modules/.bin/tsx", "apps/server/src/index.ts"]
