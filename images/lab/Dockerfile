# LabForge lab image: Ubuntu 24.04 + ttyd web terminal, non-root.
# Built multi-arch (linux/amd64, linux/arm64) via docker buildx in CI.
FROM ubuntu:24.04

# ttyd (web terminal) lives in the universe component on 24.04.
# --no-install-recommends + cleanup keeps the layer small.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ttyd \
      bash \
      ca-certificates \
      curl \
      wget \
      git \
      vim \
      nano \
      python3 \
      python3-pip \
      net-tools \
      iputils-ping \
      htop \
      tmux \
      man-db \
      manpages \
      less \
    && rm -rf /var/lib/apt/lists/*

# Non-root user `lab` (UID/GID 1000), no sudo.
RUN groupadd --gid 1000 lab \
    && useradd --uid 1000 --gid 1000 --create-home --shell /bin/bash lab

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
# Sourced by `bash --login`; prints the lab's expiry banner.
COPY motd.sh /etc/profile.d/00-labforge-motd.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Runs as non-root; the pod spec also enforces runAsUser 1000 / runAsNonRoot.
USER 1000:1000
WORKDIR /home/lab

# ttyd serves the terminal on 7681.
EXPOSE 7681

# LAB_ID (ttyd base path) is injected by the pod spec. Expiry for the MOTD is
# read from the downward API file /etc/labforge/expires-at.
ENV LAB_ID=""

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
