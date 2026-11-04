FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts/patch-liveline.mjs ./scripts/patch-liveline.mjs
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && mkdir -p /app/data && chown -R node:node /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV DATA_DIR=/app/data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "start"]
