FROM node:22-alpine

WORKDIR /app
COPY server.js index.html package.json ./
RUN mkdir -p /app/data && chown node:node /app/data

ENV NODE_ENV=production DATA_DIR=/app/data
VOLUME /app/data
EXPOSE 3000
USER node

HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "server.js"]
