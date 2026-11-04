# LabForge MOTD — sourced by bash --login. Must not `exit`.
# EXPIRES_AT is a Unix epoch (seconds), injected by the pod spec.
if [ -n "${EXPIRES_AT:-}" ]; then
  __lf_when="$(date -u -d "@${EXPIRES_AT}" '+%Y-%m-%d %H:%M:%S UTC' 2>/dev/null || echo "${EXPIRES_AT}")"
  __lf_left=$(( EXPIRES_AT - $(date +%s) ))
  __lf_min=$(( __lf_left / 60 ))
  echo "┌──────────────────────────────────────────────┐"
  echo "│  LabForge temporary lab                        │"
  echo "│  This environment is wiped at expiry.          │"
  printf '│  Expires: %-36s │\n' "${__lf_when}"
  printf '│  Time left: ~%-33s │\n' "${__lf_min} min"
  echo "└──────────────────────────────────────────────┘"
  unset __lf_when __lf_left __lf_min
else
  echo "LabForge lab — temporary environment (wiped at expiry)."
fi
