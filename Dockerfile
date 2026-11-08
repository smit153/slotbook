# syntax=docker/dockerfile:1

# ---- build: install all deps, compile server + build SPA ----
FROM node:24-alpine AS build
RUN npm install -g pnpm@12.18.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# ---- runtime: production deps + compiled output only ----
FROM node:24-alpine AS runtime
RUN npm install -g pnpm@12.18.0
WORKDIR /app
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
# One command: migrate → seed (both idempotent) → serve
CMD ["sh", "-c", "node dist/server/db/migrate.js && node dist/server/db/seed.js && exec node dist/server/index.js"]
