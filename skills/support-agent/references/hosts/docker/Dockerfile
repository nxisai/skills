# The Support Agent, as a container of its own.
#
# Built from a directory holding server.ts, node-server.ts, support-core.ts
# (unchanged), the site adapter as site.ts, and package.json.
#
# No ARG or ENV carries a secret: build arguments persist in the image history
# and `docker history` prints them. The model key, the relay token, the gap key
# and the turn-reference secret arrive at runtime, from compose's env_file or a
# Docker secret (<NAME>_FILE).

# ── Build: bundle the TypeScript into one file ──────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
# `npm install` rather than `ci` only because this reference ships no
# lockfile. In the project, commit package-lock.json and use `npm ci`.
RUN npm install --no-audit --no-fund
COPY *.ts ./
# The packages stay external: the runtime stage installs them, without esbuild.
RUN npx esbuild server.ts --bundle --platform=node --format=esm --target=node22 \
      --packages=external --outfile=dist/server.mjs

# ── Run ─────────────────────────────────────────────────────────────────────
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist/server.mjs ./

# Reported turns (turn references), on a volume: owned by the user the server
# runs as, so a named volume mounted here starts out writable by it.
RUN mkdir -p /data && chown node:node /data && chmod 700 /data
ENV SUPPORT_TURN_STORE=/data/turns.jsonl
VOLUME /data

# wget is already in node:*-alpine, so the health check needs no extra layer.
# 127.0.0.1, not localhost: inside the container localhost resolves to ::1
# first, and the server listens on IPv4.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4130/healthz || exit 1

USER node
EXPOSE 4130
# Node itself as PID 1: server.ts handles SIGTERM (finish the turns, then the
# gap reports, then exit). `npm start` would sit in between and swallow it.
CMD ["node", "server.mjs"]
