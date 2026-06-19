FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    poppler-utils \
    qpdf \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json .
RUN npm install --production

COPY src/ ./src/

RUN mkdir -p /app/data

EXPOSE 8080

CMD ["node", "src/index.js"]
