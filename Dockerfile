FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev && npm cache clean --force

FROM node:22-alpine AS runtime
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN addgroup -S protheus && adduser -S protheus -G protheus \
  && mkdir -p /app/state /app/tmp /app/logs /app/secrets \
  && chown -R protheus:protheus /app

ENV NODE_ENV=production
ENV CLEARANCE=3
ENV TZ=UTC

USER protheus

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node systems/autonomy/health_status.js >/dev/null || exit 1

CMD ["node", "systems/spine/spine.js", "daily"]
