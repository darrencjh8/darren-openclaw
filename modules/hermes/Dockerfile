FROM nousresearch/hermes-agent:v2026.9.24
# gh and ntn live in the persisted /opt/data volume, installed by the
# "Ensure Hermes container tooling" step in .github/workflows/deploy.yml, so
# rebuilding this image does not reinstall them.
RUN apt-get update && apt-get install -y --no-install-recommends \
    poppler-utils \
    qpdf \
    && rm -rf /var/lib/apt/lists/*
COPY config.yaml SOUL.md.template /opt/hermes-defaults/
COPY skills/ /opt/hermes-defaults/skills/
COPY scripts/ /opt/hermes-defaults/scripts/
COPY profiles/ /opt/hermes-defaults/profiles/
RUN chmod +x /opt/hermes-defaults/scripts/*.sh
COPY 50-seed-defaults /etc/cont-init.d/50-seed-defaults
RUN chmod +x /etc/cont-init.d/50-seed-defaults
