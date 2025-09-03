# /opt/site/Dockerfile
FROM node:20-bookworm-slim

# dependências p/ módulos nativos (better-sqlite3; fallback do sharp)
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Instala deps em modo produção
COPY package*.json ./
RUN npm ci --omit=dev

# Copia o restante do código
COPY . .

# Diretórios de dados/arquivos (serão volumes)
RUN mkdir -p /app/data /app/uploads \
 && chown -R node:node /app

ENV NODE_ENV=production
ENV PORT=3000
# Ajusta o caminho do DB/Uploads para usar os volumes
ENV DB_PATH=/app/data/campaign.db
ENV UPLOADS_DIR=/app/uploads

USER node
EXPOSE 3000

CMD ["node", "server.js"]
