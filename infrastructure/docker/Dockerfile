# Multi-stage build for the operating layer. Build with a target:
#   docker build -f infrastructure/docker/Dockerfile --target api    -t operating-layer/api .
#   docker build -f infrastructure/docker/Dockerfile --target worker -t operating-layer/worker .
#   docker build -f infrastructure/docker/Dockerfile --target web    -t operating-layer/web .
FROM node:22-slim AS build
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@11.3.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY connectors ./connectors
COPY workflows ./workflows
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:22-slim AS api
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=build /repo ./
EXPOSE 3001
CMD ["node", "apps/api/dist/main.js"]

FROM node:22-slim AS worker
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=build /repo ./
CMD ["node", "apps/worker/dist/main.js"]

FROM node:22-slim AS web
WORKDIR /repo
ENV NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@11.3.0 --activate
COPY --from=build /repo ./
EXPOSE 3000
CMD ["pnpm", "--filter", "@operating-layer/web", "start"]
