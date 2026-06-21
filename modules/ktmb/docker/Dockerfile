FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl cron \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip pip install -r requirements.txt

COPY src/ ./src/
COPY src/utils/ ./src/utils/
COPY ktmb_server.py .
COPY ktmb_core.py ktmb_worker.py ktmb_reset.py .
COPY skills/ ./skills/

# Cron worker (cron file written at runtime so env vars are available)
RUN touch /var/log/ktmb-cron.log

EXPOSE 8082

HEALTHCHECK --interval=30s --timeout=3s \
    CMD curl -f http://localhost:8082/health || exit 1

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
