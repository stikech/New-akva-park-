# Образ для любого хостинга с Docker (Koyeb, Fly.io, VPS…). Внешних зависимостей нет — npm install не нужен.
FROM node:22-alpine

WORKDIR /app
COPY package.json ./
COPY frontend ./frontend
COPY backend ./backend

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "backend/src/server.js"]
