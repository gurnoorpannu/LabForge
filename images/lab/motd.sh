# LabForge MOTD — sourced by bash --login. Must not `exit`.
# Expiry (unix seconds) comes from a downward API file that mirrors the pod's
# labforge.io/expires-at annotation. A file (not an env var) because warm-pool
# labs only get an expiry when claimed, after the pod is already running.
__lf_file=/etc/labforge/expires-at
__lf_exp="$(cat "$__lf_file" 2>/dev/null || true)"
if [ -n "$__lf_exp" ]; then
  __lf_when="$(date -u -d "@${__lf_exp}" '+%Y-%m-%d %H:%M UTC' 2>/dev/null || echo "$__lf_exp")"
  __lf_min=$(( (__lf_exp - $(date +%s)) / 60 ))
  echo "┌──────────────────────────────────────────────┐"
  echo "│  LabForge temporary lab                      │"
  echo "│  Everything here is wiped at expiry.         │"
  printf '│  Expires:   %-33s│\n' "$__lf_when"
  printf '│  Time left: %-33s│\n' "~${__lf_min} min"
  echo "└──────────────────────────────────────────────┘"
else
  echo "LabForge lab: temporary environment, wiped at expiry."
fi
unset __lf_file __lf_exp __lf_when __lf_min
