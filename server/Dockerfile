FROM node:22-alpine
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --production

COPY src/ ./src/

ENV PORT=3000
ENV HOST=0.0.0.0
ENV DB_PATH=/app/data/threadthink.db

RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "src/index.js"]
