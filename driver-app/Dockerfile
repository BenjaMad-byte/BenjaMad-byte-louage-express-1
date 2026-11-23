# Construit depuis la racine du dépôt (voir docker-compose.yml) : driver-app importe des fichiers
# de driver-portal par chemin relatif (../driver-portal/...), les deux dossiers doivent être présents.
FROM node:22-alpine
WORKDIR /repo

COPY driver-portal ./driver-portal
COPY driver-app ./driver-app

WORKDIR /repo/driver-app
RUN npm ci --omit=dev

EXPOSE 4200
CMD ["node", "server.js"]
