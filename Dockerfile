# AgentUse Docker Image
#
# Version Pinning Strategy:
# - All base images and major packages are pinned to specific versions
# - This ensures reproducible builds across different environments and time periods
# - Update versions periodically to get security patches and bug fixes
#
# Current Versions:
# - Bun: 1.3.2 (build tool)
# - Alpine: 3.20.3 (base OS)
# - Node.js: ~20.x (runtime)
# - Python: ~3.12.x (runtime)
#
# To update versions:
# 1. Update the version numbers below
# 2. Test the build locally: docker build -t agentuse-test .
# 3. Test the image: docker run --rm agentuse-test --version
# 4. Update this comment with new version numbers

# Stage 1: Build the binary using Bun
FROM --platform=$BUILDPLATFORM oven/bun:1.3.2-alpine AS builder

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
# Pin to specific Alpine patch version for reproducibility
FROM alpine:3.20.3

# Install Node.js, Python, and utilities with pinned versions
# Note: Package versions are tied to Alpine 3.20.3 repository snapshot
RUN apk add --no-cache \
    nodejs~=20 \
    npm~=10 \
    python3~=3.12 \
    py3-pip~=24 \
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
