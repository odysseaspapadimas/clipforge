FROM oven/bun:1.3.14-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production
COPY server.ts captions.ts ./
USER bun
EXPOSE 8080
CMD ["bun", "server.ts"]
