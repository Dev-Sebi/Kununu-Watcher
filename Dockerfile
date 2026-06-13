# Playwright base image — bundles Chromium + system deps, matched to the
# playwright npm version in package.json (keep both in sync).
FROM mcr.microsoft.com/playwright:v1.60.0-jammy

WORKDIR /app

# Install deps first for better layer caching
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --prod --frozen-lockfile

COPY index.js ./

# db.json lives here — mount a volume to persist it
RUN mkdir -p /app/data
ENV DB_PATH=/app/data/db.json

CMD ["node", "index.js"]
