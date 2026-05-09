FROM node:22-slim AS deps

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM node:22-slim

ENV NODE_ENV=production
ENV MIGRATIONS_DIR=/data/drizzle
WORKDIR /app

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json pnpm-lock.yaml tsconfig.json drizzle.config.ts config.example.yaml ./
COPY --chown=node:node src ./src
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN mkdir -p /data \
  && chown node:node /data \
  && chmod +x /usr/local/bin/docker-entrypoint.sh

USER node

VOLUME ["/data"]
EXPOSE 8008

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--import", "tsx", "./src/index.ts"]
