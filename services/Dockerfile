# One Dockerfile for the three Node services; pick one with --build-arg SERVICE=
#   docker buildx build -f services/Dockerfile --build-arg SERVICE=api .
# Multi-arch (linux/amd64, linux/arm64) in CI. Pure JS deps, no native modules.
FROM node:24-alpine AS build
WORKDIR /app
# Manifests first: the npm ci layer is cached until dependencies change.
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY services/shared/package.json services/shared/
COPY services/api/package.json services/api/
COPY services/pool-controller/package.json services/pool-controller/
COPY services/reaper/package.json services/reaper/
RUN npm ci --ignore-scripts
COPY services ./services
RUN npx tsc --build \
 && find services -path '*/dist/*' \( -name '*.test.*' -o -name 'test-helpers.*' \) -delete \
 && npm prune --omit=dev --ignore-scripts

FROM node:24-alpine
ARG SERVICE
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/services/shared/package.json ./services/shared/
COPY --from=build /app/services/shared/dist ./services/shared/dist
COPY --from=build /app/services/${SERVICE}/package.json ./services/${SERVICE}/
COPY --from=build /app/services/${SERVICE}/dist ./services/${SERVICE}/dist
WORKDIR /app/services/${SERVICE}
# The image's built-in non-root user (uid 1000). Runs with a read-only root FS.
USER node
CMD ["node", "dist/index.js"]
