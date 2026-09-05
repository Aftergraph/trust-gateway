# Trust Gateway — deployable container
# Zero-dependency Node.js runtime; node:22-alpine base.
FROM node:22-alpine

WORKDIR /app

# Copy only what the gateway needs (package.json for engines metadata).
COPY package.json ./
COPY src/ ./src/
COPY bin/ ./bin/
COPY app/ ./app/

# Fail-closed: no default secrets. Config is 100% env-injected at runtime.
ENV NODE_ENV=production
ENV TG_PORT=8800
EXPOSE 8800

# Healthcheck hits /healthz (chain verification built in).
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${TG_PORT}/healthz || exit 1

# Run as non-root (security posture: the gateway should never need root).
USER node

CMD ["node", "src/gateway/server.js"]
