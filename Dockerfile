# Multi-stage Dockerfile for mmp-renamer
# Builder stage: build the Vite web UI
FROM node:20-bullseye AS builder
WORKDIR /usr/src/app

# Install build dependencies
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
	   git ca-certificates build-essential python3 pkg-config libsqlite3-dev \
	&& rm -rf /var/lib/apt/lists/*

# Copy local source instead of cloning
COPY . ./repo

WORKDIR /usr/src/app/repo

# Install server dependencies
RUN npm ci || (echo "npm ci failed in repo root, trying npm install without --silent to see errors..." && npm install)

# Build the web UI
WORKDIR /usr/src/app/repo/web
RUN npm ci --ignore-scripts || npm install --ignore-scripts
RUN npm rebuild
RUN npm run build

# Runtime image
FROM node:20-bullseye-slim AS runtime
WORKDIR /usr/src/app
ENV NODE_ENV=production
ENV PORT=5173

# Ensure CA certs for TLS calls
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates git libsqlite3-0 \
	&& rm -rf /var/lib/apt/lists/*

# Copy artifacts from builder
COPY --from=builder /usr/src/app/repo/package.json ./package.json
COPY --from=builder /usr/src/app/repo/package-lock.json* ./package-lock.json*
COPY --from=builder /usr/src/app/repo/node_modules ./node_modules
COPY --from=builder /usr/src/app/repo/scripts ./scripts
COPY --from=builder /usr/src/app/repo/server.js ./server.js
COPY --from=builder /usr/src/app/repo/lib ./lib
COPY --from=builder /usr/src/app/repo/README.md ./README.md
COPY --from=builder /usr/src/app/repo/web/dist ./web/dist

# Ensure migration scripts are executable
RUN if [ -d ./scripts ]; then chmod +x ./scripts/*.js || true; fi

# Create data dir
RUN mkdir -p /usr/src/app/data && chown -R node:node /usr/src/app

USER node
EXPOSE 5173
VOLUME ["/usr/src/app/data"]
CMD ["npm", "start"]
