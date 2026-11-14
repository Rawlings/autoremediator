# node:24-alpine as of 2026-05-01
ARG NODE_IMAGE=node:24-alpine@sha256:8e2c930fda481a6ec141fe5a88e8c249c69f8102fe98af505f38c081649ea749

# Build the CLI from this checkout so the image always matches the source it was built from
# (previously this installed a hard-coded, long-outdated version from npm).
FROM ${NODE_IMAGE} AS build
WORKDIR /src
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/core/package.json packages/core/package.json
RUN pnpm install --frozen-lockfile --filter autoremediator...
COPY packages/core packages/core
RUN pnpm --filter autoremediator build
RUN cd packages/core && pnpm pack --pack-destination /out

FROM ${NODE_IMAGE}
COPY --from=build /out/autoremediator-*.tgz /tmp/autoremediator.tgz
RUN npm install -g /tmp/autoremediator.tgz && rm /tmp/autoremediator.tgz

WORKDIR /workdir

RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

ENTRYPOINT ["autoremediator"]
CMD ["--help"]
