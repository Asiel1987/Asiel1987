# =============================================================================
# Stage 1 — deps: install production dependencies only
# =============================================================================
FROM node:20-alpine AS deps

WORKDIR /app

# Copy package manifests first (layer-cache friendly)
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production

# =============================================================================
# Stage 2 — runtime: lean final image
# =============================================================================
FROM node:20-alpine AS runtime

WORKDIR /app

# Copy installed node_modules from the deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application source
COPY src/ ./src/

# Copy any migrations so the app can run them at start-up if needed
COPY migrations/ ./migrations/

# Copy package.json for runtime metadata (engines field, main entry, etc.)
COPY package.json ./

# Drop root privileges — run as the built-in "node" user
USER node

EXPOSE 3001

CMD ["node", "src/index.js"]
