# Multi-stage Dockerfile for mmp-renamer
# Builder stage: build the Vite web UI
FROM node:20-bullseye AS builder
WORKDIR /usr/src/app

# Install minimal packages useful for some native builds and TLS certs
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

# Install web dependencies and build static assets
COPY web/package.json web/package-lock.json* ./web/
WORKDIR /usr/src/app/web
# Prefer reproducible install; fall back to `npm install` if no lockfile is present
RUN npm ci --silent || npm install --silent
COPY web/ ./
RUN npm run build --silent

# Runtime image: slim, production-only
FROM node:20-bullseye-slim AS runtime
WORKDIR /usr/src/app
ENV NODE_ENV=production
ENV PORT=5173

# Ensure CA certs for TLS calls
RUN apt-get update \ 
	&& apt-get install -y --no-install-recommends ca-certificates \ 
	&& rm -rf /var/lib/apt/lists/*

# Copy server package files and install production deps only
COPY package.json package-lock.json* ./
# Use npm ci if lockfile exists, otherwise fall back to npm install
RUN npm ci --production --silent --no-audit --no-fund || npm install --production --silent --no-audit --no-fund

# Copy only the files needed to run the server
COPY server.js ./server.js
COPY lib ./lib
COPY README.md ./README.md

# Create the data directory and ensure node user owns it (server persists JSON here)
RUN mkdir -p /usr/src/app/data && chown -R node:node /usr/src/app

# Copy built web assets from builder stage
COPY --from=builder /usr/src/app/web/dist ./web/dist

# Run as non-root
USER node

# Expose default server port (configurable via PORT env var)
EXPOSE 5173

# Persist data outside the container by default
VOLUME ["/usr/src/app/data"]

# Default command uses the package.json start script (node server.js)
CMD ["npm", "start"]
