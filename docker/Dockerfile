# syntax=docker/dockerfile:1.7
#
# Netra OCR: web app and REST API, with the model bundles baked in so it runs offline.
#
#   docker build -f docker/Dockerfile -t netra-ocr .
#   docker run -p 8000:8000 -v netra-data:/data netra-ocr
#   then open http://localhost:8000
#
# CPU only. The models run on ONNX Runtime (src/pipeline.ts); PDF pages are rendered with
# Ghostscript. The build fails if any model bundle cannot be downloaded.

ARG NODE_VERSION=22

# ── deps: npm installs the packages, including sharp's native binaries ─────────
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
COPY package.json ./
# The repository has no package-lock.json yet, so this resolves the latest matching versions.
# Commit a lock file and switch to `npm ci` to make builds reproducible.
RUN npm install --no-audit --no-fund

# ── models: download every bundle once, at build time ──────────────────────────
FROM deps AS models
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
ENV NETRA_MODELS_DIR=/models
RUN mkdir -p /models && npx tsx scripts/prefetch-models.ts

# ── runtime ────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
LABEL org.opencontainers.image.title="Netra OCR" \
      org.opencontainers.image.description="Khmer and English document OCR: layout analysis, recognition, editable structured export" \
      org.opencontainers.image.source="https://github.com/netra-ai-lab/Netra-OCR" \
      org.opencontainers.image.licenses="MIT"

RUN apt-get update \
 && apt-get install -y --no-install-recommends ghostscript ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 10001 netra \
 && mkdir -p /data \
 && chown -R netra /data

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json server.ts readme.md LICENSE ./
COPY src ./src
COPY static ./static
COPY samples ./samples
COPY --from=models /models /models

ENV NODE_ENV=production \
    NETRA_HOST=0.0.0.0 \
    NETRA_PORT=8000 \
    NETRA_DATA_DIR=/data \
    NETRA_MODELS_DIR=/models

USER netra
VOLUME ["/data"]
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:' + (process.env.NETRA_PORT || 8000) + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "--import", "tsx", "server.ts"]
