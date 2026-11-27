FROM node:22-alpine
WORKDIR /repo

# sqlite (CLI sqlite3, copie cohérente de la base) + age (chiffrement des sauvegardes) : utilisés par deploy/backup.sh,
# lancé via `docker compose exec driver-portal ...` (voir deploy/DEPLOY.md § Sauvegardes et § Rotation de clé).
RUN apk add --no-cache sqlite age

COPY driver-portal ./driver-portal

WORKDIR /repo/driver-portal
RUN npm ci --omit=dev

EXPOSE 4100
CMD ["node", "server.js"]
