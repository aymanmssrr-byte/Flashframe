FROM node:20-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=3000 \
    WORK_DIR=/tmp/flashframe \
    LIBRARY_DIR=/data/library

# /data recoit un volume monte par la plateforme : c'est la seule chose a
# garder entre deux deploiements. Pas d'instruction VOLUME ici, Railway la
# refuse et gere le montage de son cote.
RUN mkdir -p /data/library

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# fichiers listes un par un : rien d'autre du depot n'entre dans l'image,
# et aucun fichier cache n'est necessaire pour que le build soit correct
COPY server.js ffmpeg.js library.js store.js index.html ./

EXPOSE 3000

# ffmpeg fait le gros du travail : un seul worker node suffit
CMD ["node", "server.js"]
