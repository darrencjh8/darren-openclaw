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
# Hermes WebUI (github.com/nesquena/hermes-webui) as a supervised service in
# this container, so it shares /opt/hermes, the agent venv, and HERMES_HOME with
# the gateway instead of holding a second copy of the agent source.
#
# Pinned to the commit behind tag v0.52.113. The fetch names the commit rather
# than the tag, so re-pointing the tag upstream cannot change what a rebuild
# produces, and a commit that no longer exists fails the build instead of
# silently building a different revision.
ARG HERMES_WEBUI_REF=c67fd2dd270a1128c2754200406bca58e9d9a25a
RUN git init /opt/hermes-webui \
    && cd /opt/hermes-webui \
    && git remote add origin https://github.com/nesquena/hermes-webui.git \
    && git fetch --depth 1 origin "$HERMES_WEBUI_REF" \
    && git checkout --detach FETCH_HEAD
COPY webui/s6-rc.d/hermes-webui /etc/s6-overlay/s6-rc.d/hermes-webui
RUN chmod +x /etc/s6-overlay/s6-rc.d/hermes-webui/run \
    && touch /etc/s6-overlay/s6-rc.d/user/contents.d/hermes-webui
# Debian's /etc/profile replaces PATH before it sources /etc/profile.d, so a
# login shell (`bash -lc`, `sh -lc`) loses the image PATH entry for the
# persisted volume directory and cannot see gh or ntn. Put it back for them;
# non-login shells already inherit it from the image environment.
RUN printf 'PATH="$PATH:/opt/data/.local/bin"\n' > /etc/profile.d/90-hermes-local-bin.sh
