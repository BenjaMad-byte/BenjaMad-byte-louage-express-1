FROM node:22-alpine
WORKDIR /repo

COPY driver-portal ./driver-portal

WORKDIR /repo/driver-portal
RUN npm ci --omit=dev

EXPOSE 4100
CMD ["node", "server.js"]
