# Multi-stage Dockerfile for mmp-renamer
# Builder stage: clone repo and build the Vite web UI
FROM node:20-bullseye AS builder
WORKDIR /usr/src/app

# Build args: allow overriding repo and ref at build time
ARG REPO_URL=https://github.com/jt-ito/MMP-Renamer.git
ARG REPO_REF=main

# Install git + ca-certs for cloning and TLS
RUN apt-get update \
	&& apt-get install -y --no-install-recommends git ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

# Clone the repository (shallow) and prepare web build
RUN git clone --depth 1 --branch ${REPO_REF} ${REPO_URL} repo
WORKDIR /usr/src/app/repo/web
# Prefer reproducible install; fall back to `npm install` if needed
RUN npm ci --silent || npm install --silent
COPY repo/web ./
RUN npm run build --silent

# Runtime image: slim, production-only
FROM node:20-bullseye-slim AS runtime
WORKDIR /usr/src/app
ENV NODE_ENV=production
ENV PORT=5173

# Ensure CA certs for TLS calls
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates git \
	&& rm -rf /var/lib/apt/lists/*

# Copy package files from the cloned repo in the builder and install production deps
COPY --from=builder /usr/src/app/repo/package.json ./package.json
COPY --from=builder /usr/src/app/repo/package-lock.json* ./package-lock.json*
RUN npm ci --production --silent --no-audit --no-fund || npm install --production --silent --no-audit --no-fund

# Copy server source and built web assets from builder
COPY --from=builder /usr/src/app/repo/server.js ./server.js
COPY --from=builder /usr/src/app/repo/lib ./lib
COPY --from=builder /usr/src/app/repo/README.md ./README.md
COPY --from=builder /usr/src/app/repo/web/dist ./web/dist

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
