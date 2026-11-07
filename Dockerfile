FROM node:22-bookworm-slim

# ffmpeg decodes uploads and encodes the final H.264 + AAC MP4.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY public ./public
COPY server ./server

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    MAX_UPLOAD_MB=500 \
    MAX_CONCURRENT_JOBS=1 \
    JOB_TTL_MINUTES=60

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/server.js"]
