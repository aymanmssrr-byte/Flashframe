FROM node:20-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=3000 \
    WORK_DIR=/tmp/flashframe \
    LIBRARY_DIR=/data/library

# /data doit etre un volume : c'est la seule chose a garder entre deux deploiements
RUN mkdir -p /data/library
VOLUME ["/data"]

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY src ./src
COPY public ./public

EXPOSE 3000

# ffmpeg fait le gros du travail : un seul worker node suffit
CMD ["node", "src/server.js"]
