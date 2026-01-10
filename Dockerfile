FROM node:20-alpine AS builder

WORKDIR /app

# Install all deps (including dev for build)
COPY package*.json ./
RUN npm ci

# Copy source and build
COPY build.js ./
COPY src ./src
RUN npm run build

# Production image
FROM node:20-alpine

WORKDIR /app

# Install production deps only
COPY package*.json ./
RUN npm ci --omit=dev

# Copy server and built assets
COPY server.js ./
COPY --from=builder /app/public ./public

EXPOSE 8080

CMD ["node", "server.js"]
