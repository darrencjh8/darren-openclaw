FROM node:24-alpine
WORKDIR /app
COPY package.json .
RUN npm install --production --no-audit --no-fund && mkdir -p /tmp/actual-data
COPY server.js .
EXPOSE 3000
CMD ["node", "server.js"]
