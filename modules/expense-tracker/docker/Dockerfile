FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    poppler-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip pip install -r requirements.txt

# Pre-download the embeddings model at build time (avoids runtime download)
RUN python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('all-MiniLM-L6-v2', backend='onnx')"

COPY src/ ./src/
COPY config/ ./config/

RUN mkdir -p /app/data

EXPOSE 8080

CMD ["python", "-m", "src.main"]
