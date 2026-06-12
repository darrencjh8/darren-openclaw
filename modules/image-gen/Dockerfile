FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json .
RUN npm install --production
COPY server.js .
EXPOSE 8083
CMD ["node", "server.js"]
