# node:26-alpine as of 2026-11-14
ARG NODE_IMAGE=node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5

# Build the CLI from this checkout so the image always matches the source it was built from
# (previously this installed a hard-coded, long-outdated version from npm).
FROM ${NODE_IMAGE} AS build
WORKDIR /src
# Node 25+ no longer ships corepack, so install pnpm directly.
RUN npm install -g pnpm@12.18.0
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/core/package.json packages/core/package.json
RUN pnpm install --frozen-lockfile --filter autoremediator...
COPY tsconfig.base.json ./
COPY packages/core packages/core
RUN pnpm --filter autoremediator build
# core's prepack hook copies README.md and llms.txt from the repo root into the package.
COPY README.md llms.txt ./
RUN cd packages/core && pnpm pack --pack-destination /out

FROM ${NODE_IMAGE}
COPY --from=build /out/autoremediator-*.tgz /tmp/autoremediator.tgz
RUN npm install -g --ignore-scripts /tmp/autoremediator.tgz && rm /tmp/autoremediator.tgz

WORKDIR /workdir

# git is required for change requests (branch, commit, push). `safe.directory` names the one place a
# checkout is mounted, so the non-root user can work in it although a different uid owns it; a
# wildcard would also trust any repository under it, with its hooks and filters.
RUN apk add --no-cache git \
    && git config --system --add safe.directory /workdir

RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

ENTRYPOINT ["autoremediator"]
CMD ["--help"]
