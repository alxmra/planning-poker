FROM node:22-alpine

WORKDIR /app

COPY server.js index.html package.json ./

ENV DATA_DIR=/app/data

RUN mkdir -p /app/data && chown node:node /app/data

VOLUME /app/data

EXPOSE 3000

USER node

CMD ["node", "server.js"]
