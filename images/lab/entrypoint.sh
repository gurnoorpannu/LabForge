#!/usr/bin/env bash
# LabForge lab entrypoint: start ttyd on the lab's base path.
#
#   -W            writable (allow keyboard input to the terminal)
#   -p 7681       listen port (matches the Service / readiness probe)
#   -b /lab/<id>  base path so URLs resolve behind Traefik path routing
#                 (Ingress does NOT strip the prefix — ttyd owns the full path)
#
# Flags verified against ttyd 1.7.x (Ubuntu 24.04). `ttyd --help` lists them.
set -euo pipefail

BASE_PATH="/lab/${LAB_ID:-}"

# Interactive login shell so /etc/profile.d (and the MOTD) run.
exec ttyd -W -p 7681 -b "${BASE_PATH}" bash --login
