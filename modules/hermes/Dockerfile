FROM nousresearch/hermes-agent:v2026.6.5
RUN apt-get update && apt-get install -y --no-install-recommends gh && rm -rf /var/lib/apt/lists/*
COPY config.yaml SOUL.md.template /opt/hermes-defaults/
COPY skills/ /opt/hermes-defaults/skills/
COPY scripts/ /opt/hermes-defaults/scripts/
COPY profiles/ /opt/hermes-defaults/profiles/
# Overlay patched hermes_state.py with SessionDB init retry-with-jitter fix.
# See: #76 — prevents "database is locked" when multiple processes (gateway,
# CLI, kanban workers) contend on state.db schema init.
COPY hermes_state.py /opt/hermes/hermes_state.py
RUN chmod +x /opt/hermes-defaults/scripts/*.sh
COPY 50-seed-defaults /etc/cont-init.d/50-seed-defaults
RUN chmod +x /etc/cont-init.d/50-seed-defaults
