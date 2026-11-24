FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY index.html vite.config.js ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/data
RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep python3 python3-venv ca-certificates tini procps && rm -rf /var/lib/apt/lists/*
RUN npm install -g opencode-ai@1.2.27 && opencode --version
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && mkdir -p /data && chown node:node /data
COPY server ./server
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/index.js"]
