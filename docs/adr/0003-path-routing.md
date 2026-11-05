# ADR-0003: Path-based routing on one host, not wildcard subdomains

**Status:** accepted

## Context
Labs must be reachable at a URL per lab: `https://<domain>/lab/<id>/` or
`https://<id>.<domain>/`.

## Decision
One host, path `/lab/<id>/`. ttyd runs with `-b /lab/<id>` so it owns the full path
(no prefix stripping), and the session cookie is host-only.

## Consequences
- **One certificate, HTTP-01:** a single Let's Encrypt cert for one name, served as Traefik's
  default so every lab Ingress uses it. Wildcards need DNS-01, i.e. DNS-provider API credentials
  in the cluster.
- **One cookie, no Domain attribute:** the login cookie is sent to the UI and every lab without
  widening it to `*.domain`.
- **Same origin, mitigated:** labs and the UI share an origin. A lab only serves ttyd (the
  user can't replace it: ttyd is the container's main process), and ForwardAuth refuses anyone
  but the owner, so another user can't be made to load a lab's page. Subdomains would give
  real origin isolation and are the upgrade if labs ever serve user content.
- Path tricks (`/lab/a/../b`) are a known risk with path routing; ADR-0001 removes them.
