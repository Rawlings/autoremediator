FROM node:24-alpine@sha256:8e2c930fda481a6ec141fe5a88e8c249c69f8102fe98af505f38c081649ea749 # 24-alpine as of 2026-05-01

RUN npm install -g autoremediator@0.14.1

WORKDIR /workdir

RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

ENTRYPOINT ["autoremediator"]
CMD ["--help"]
