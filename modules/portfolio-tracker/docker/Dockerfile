FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    poppler-utils \
    openjdk-17-jre-headless \
    python3 \
    make \
    gcc \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json .
RUN npm install --production

COPY src/ ./src/
COPY pp-cli/target/pp-cli.jar /app/pp-cli.jar

RUN mkdir -p /app/data

EXPOSE 8081

CMD ["node", "src/index.js"]
