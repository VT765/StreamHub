# StreamHub API — built from the repo root (npm workspaces): docker build -f server/Dockerfile .
FROM node:22-bookworm-slim

# ffmpeg generates the sample video catalog; openssl is needed by Prisma's query engine.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci -w server

COPY server ./server
WORKDIR /app/server
# Prisma client, compiled server, and the sample videos/thumbnails/captions (not stored in git).
RUN npx prisma generate && npm run build && npm run media:fetch

ENV NODE_ENV=production
EXPOSE 10000
# Seeding is idempotent: it refreshes video records (incl. file sizes of the freshly built media)
# and creates the demo accounts if they're missing.
CMD ["sh", "-c", "npx tsx prisma/seed.ts && node dist/index.js"]
