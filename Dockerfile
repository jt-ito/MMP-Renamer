# Multi-stage Dockerfile for mmp-renamer
# Builder stage: clone repo and build the Vite web UI
FROM node:20-bullseye AS builder
WORKDIR /usr/src/app

# Build args: allow overriding repo and ref at build time
ARG REPO_URL=https://github.com/jt-ito/MMP-Renamer.git
ARG REPO_REF=main

# Install git + ca-certs for cloning and TLS
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
	   git ca-certificates build-essential python3 pkg-config libsqlite3-dev \
	&& rm -rf /var/lib/apt/lists/*

# Clone the repository (shallow) and prepare web build
RUN git clone --depth 1 --branch ${REPO_REF} ${REPO_URL} repo
WORKDIR /usr/src/app/repo
# Install server dependencies (including native modules like better-sqlite3) in the builder
# so that node_modules copied into the runtime already contain compiled native addons.
# Add diagnostics: print node/npm versions and list files to help debug CI failures.
RUN node -v && npm -v && pwd && ls -la
RUN npm ci || (echo "npm ci failed in repo root, trying npm install without --silent to see errors..." && npm install)

# Build the web UI inside the repo/web directory
WORKDIR /usr/src/app/repo/web
# Prefer reproducible install; fall back to `npm install` if needed
# Add diagnostics before running npm to capture environment info when builds fail in CI.
RUN node -v && npm -v && pwd && ls -la
RUN npm ci || (echo "npm ci failed in repo/web, trying npm install without --silent to see errors..." && npm install)
RUN npm run build

# Ensure node_modules (including native modules) are built in the builder
RUN ls -la node_modules || true

# Runtime image: slim, production-only
FROM node:20-bullseye-slim AS runtime
WORKDIR /usr/src/app
ENV NODE_ENV=production
ENV PORT=5173

# Ensure CA certs for TLS calls
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates git libsqlite3-0 \
	&& rm -rf /var/lib/apt/lists/*

# Copy package files from the cloned repo in the builder and node_modules that were built there
# Copy package files for reference
COPY --from=builder /usr/src/app/repo/package.json ./package.json
COPY --from=builder /usr/src/app/repo/package-lock.json* ./package-lock.json*

# Copy built node_modules (includes native modules compiled in builder)
# If node_modules isn't copied for some reason, the next block will run `npm ci --production`.
COPY --from=builder /usr/src/app/repo/node_modules ./node_modules

# Copy scripts (migration utilities) from repo
COPY --from=builder /usr/src/app/repo/scripts ./scripts

# Copy server source and built web assets from builder
COPY --from=builder /usr/src/app/repo/server.js ./server.js
COPY --from=builder /usr/src/app/repo/lib ./lib
COPY --from=builder /usr/src/app/repo/README.md ./README.md
COPY --from=builder /usr/src/app/repo/web/dist ./web/dist

# Ensure migration scripts are executable
RUN if [ -d ./scripts ]; then chmod +x ./scripts/*.js || true; fi

# Defensive: if node_modules wasn't copied (empty), install production deps at runtime
RUN if [ ! -d ./node_modules ] || [ -z "$(ls -A ./node_modules 2>/dev/null)" ]; then \
			npm ci --production --silent || npm install --production --silent ; \
		fi

# Create the data directory and ensure node user owns it (server persists JSON here)
RUN mkdir -p /usr/src/app/data && chown -R node:node /usr/src/app

# Run as non-root
USER node

# Expose default server port (configurable via PORT env var)
EXPOSE 5173

# Persist data outside the container by default
VOLUME ["/usr/src/app/data"]

# Default command uses the package.json start script (node server.js)
CMD ["npm", "start"]
