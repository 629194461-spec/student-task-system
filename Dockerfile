FROM node:24-bookworm-slim

WORKDIR /app
COPY package.json server.mjs storage.mjs index.html app.js styles.css ./
COPY assets ./assets
COPY scripts ./scripts

ENV NODE_ENV=production
ENV HOST=0.0.0.0
EXPOSE 4173
VOLUME ["/app/data"]
CMD ["node", "server.mjs"]
