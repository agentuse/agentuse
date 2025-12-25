# Stage 1: Build the binary using Bun
FROM --platform=$BUILDPLATFORM oven/bun:1-alpine AS builder

# Docker sets TARGETARCH automatically (amd64 or arm64)
ARG TARGETARCH

WORKDIR /app

# Copy package files
COPY package.json ./

# Install dependencies (bun can read package.json directly)
RUN bun install

# Copy source files
COPY src/ ./src/
COPY bin/ ./bin/
COPY tsconfig.json ./

# Build standalone binary for alpine (musl)
# Bun cross-compiles: amd64 -> bun-linux-x64-musl, arm64 -> bun-linux-arm64-musl
RUN BUN_TARGET=$([ "$TARGETARCH" = "arm64" ] && echo "bun-linux-arm64-musl" || echo "bun-linux-x64-musl") && \
    echo "Building for $TARGETARCH using $BUN_TARGET" && \
    bun build --compile --target=$BUN_TARGET ./src/index.ts --outfile agentuse

# Stage 2: Runtime with Node.js + Python
FROM alpine:3.20

# Install Node.js, Python, and utilities
RUN apk add --no-cache \
    nodejs \
    npm \
    python3 \
    py3-pip \
    git \
    curl \
    jq \
    bash

# Copy the compiled binary
COPY --from=builder /app/agentuse /usr/local/bin/agentuse

# Ensure binary is executable
RUN chmod +x /usr/local/bin/agentuse

# Create directory for agents
RUN mkdir -p /agents

WORKDIR /agents

# Expose default port
EXPOSE 12233

# Run the server bound to all interfaces
ENTRYPOINT ["/usr/local/bin/agentuse", "serve", "-H", "0.0.0.0"]
