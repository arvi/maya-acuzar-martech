# ======================================
# 1. Base Image
# ======================================
FROM node:24-alpine AS base
WORKDIR /app

# ======================================
# 2. Dependencies Stage
# ======================================
FROM base AS dependencies
COPY package*.json ./
# Clean install including devDependencies needed for "nest build"
RUN npm ci

# ======================================
# 3. Build Stage
# ======================================
FROM base AS builder
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
# Runs "nest build" -> outputs to /app/dist
RUN npm run build

# ======================================
# 4. Production Dependencies Stage
# ======================================
FROM base AS prod-dependencies
COPY package*.json ./
RUN npm ci --omit=dev


# ======================================
# 5. Production Runner Stage
# ======================================
FROM base AS runner
ENV NODE_ENV=production

# Copy bare-minimum runtime files needed to execute the app into the production image
COPY --from=prod-dependencies /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package*.json ./

USER node
EXPOSE 3000

# Command to execute when the container runs
CMD ["node", "dist/main"]
