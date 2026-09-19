FROM node:20-bookworm-slim

WORKDIR /app

# Build tools cho better-sqlite3
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./

RUN npm install --omit=dev

COPY src ./src
COPY public ./public

RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "src/server.js"]
