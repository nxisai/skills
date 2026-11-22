# The Quote Agent, as a container of its own.
#
# Built from a directory holding server.ts, redis-store.ts, agent-core.ts
# (unchanged), the site adapter as site.ts, the field spec and package.json.
#
# No ARG or ENV carries a secret: build arguments persist in the image history
# and `docker history` prints them. The API key and the relay token arrive at
# runtime, from compose's env_file or a Docker secret.

# ── Build: bundle the TypeScript into one file ──────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
# `npm install` rather than `ci` only because this reference ships no
# lockfile. In the project, commit package-lock.json and use `npm ci`.
RUN npm install --no-audit --no-fund
COPY *.ts *.json ./
# The packages stay external: the runtime stage installs them, without esbuild.
RUN npx esbuild server.ts --bundle --platform=node --format=esm --target=node22 \
      --packages=external --outfile=dist/server.mjs

# ── Run ─────────────────────────────────────────────────────────────────────
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY --from=build /app/dist/server.mjs ./

# wget is already in node:*-alpine, so the healthcheck needs no extra layer.
# 127.0.0.1, not localhost: inside the container localhost resolves to ::1
# first, and the server listens on IPv4.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4120/healthz || exit 1

USER node
EXPOSE 4120
CMD ["node", "server.mjs"]
