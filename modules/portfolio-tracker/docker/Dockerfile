FROM node:22-slim

# Copy Java 21 JRE from Eclipse Temurin (Bookworm only ships OpenJDK 17)
COPY --from=eclipse-temurin:21-jre /opt/java/openjdk /opt/java/openjdk
ENV JAVA_HOME=/opt/java/openjdk
ENV PATH="${JAVA_HOME}/bin:${PATH}"

RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    poppler-utils \
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
