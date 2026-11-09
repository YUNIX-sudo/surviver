# ── build stage: install workspaces, build client (Vite) and server (esbuild single-file bundle) ──
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --no-audit --no-fund
COPY shared shared
COPY server server
COPY client client
RUN npm run typecheck && npm run build

# ── runtime stage: just node + one bundled file + static client ──
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0 DATA_DIR=/data STATIC_DIR=/app/client/dist
COPY --from=build /app/server/dist/index.cjs server/dist/index.cjs
COPY --from=build /app/client/dist client/dist
RUN mkdir -p /data/downloads && chown -R node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
CMD ["node", "server/dist/index.cjs"]
