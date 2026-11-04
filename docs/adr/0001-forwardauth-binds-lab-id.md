# ADR-0001: ForwardAuth learns the lab id from its own Middleware, not the request path

**Status:** accepted (Phase 3) · **Deviates from:** SPEC §6.3 ("Reads `X-Forwarded-Uri`, extracts labId")

## Context

Every request to `/lab/<id>/...` (page, assets, the terminal's websocket) passes through a Traefik
ForwardAuth middleware that asks the API "may this session open this lab?". The API needs to know
*which* lab is being opened.

The spec's approach parses it from `X-Forwarded-Uri`. That header carries the **raw** request URI,
while Traefik **routes on the cleaned path**. The two can disagree:

    GET /lab/<mine>/../<yours>/
    routed to:        <yours>   (Traefik cleans ../ before matching)
    X-Forwarded-Uri:  /lab/<mine>/../<yours>/   -> naive parse says <mine> -> allowed

That is a full bypass: any user could open any lab. Similar mismatches come from `%2e%2e`, `%2f`,
and future normalisation changes in Traefik.

## Decision

Each lab already gets its **own** Middleware in its own namespace (SPEC §6.2), so the lab id is
known when the Middleware is created. It is baked into the address:

    forwardAuth.address: http://<api>/auth/verify?lab=<labId>

`/auth/verify` reads `?lab=` and ignores the request path entirely. The value comes from cluster
config written by the API; the client cannot influence it. Also set: `trustForwardHeader: false`
and `authRequestHeaders: ["Cookie"]`.

## Consequences

- Path-confusion is ruled out by construction rather than by out-guessing Traefik's normaliser.
- Tested both ways: unit test (spoofed `X-Forwarded-Uri` -> 403) and on k3d through real Traefik
  (`../`, `%2e%2e`, `%2f` tricks and spoofed `X-Forwarded-Uri`/`Prefix` -> never 200/101).
- Cost: one Middleware object per lab (needed anyway for namespace-local references), and the
  auth address can't be shared across labs. Negligible at this scale.
