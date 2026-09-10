FROM python:3.12-slim

RUN python -m pip install --no-cache-dir httpx==0.28.1 uvicorn==0.35.0
