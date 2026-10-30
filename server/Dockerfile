FROM node:22-alpine
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server/package.json server/package-lock.json ./server/
RUN npm ci --omit=dev --prefix server

COPY core/ ./core/
COPY server/src/ ./server/src/

ENV PORT=3000
ENV HOST=0.0.0.0
ENV DB_PATH=/app/data/threadthink.db
RUN mkdir -p /app/data

WORKDIR /app/server
EXPOSE 3000
CMD ["node", "src/index.js"]
