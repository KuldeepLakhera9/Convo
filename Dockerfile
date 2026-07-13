FROM node:20-alpine AS builder
WORKDIR /app

# Copy root workspace configurations
COPY package*.json ./
COPY packages/shared/package*.json ./packages/shared/
COPY apps/api/package*.json ./apps/api/

# Install dependencies (workspaces supported)
RUN npm ci

# Copy rest of the files
COPY . .

# Build packages in dependency order
RUN npm run build --workspace=@convo/shared
RUN npm run build --workspace=api

FROM node:20-alpine
WORKDIR /app

# Copy built app and dependencies from builder stage
COPY --from=builder /app /app

EXPOSE 3002

# Run database migrations and start application
CMD ["npm", "run", "start", "--workspace=api"]
