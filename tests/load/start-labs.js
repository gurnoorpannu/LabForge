// k6 load test: N users start a lab at the same moment, then use it.
//
//   make load-test USERS=10      # see tests/load/run.sh
//
// Measures (client side, through Traefik):
//   lab_start_warm / lab_start_cold   POST /api/labs until 201, split by startedFrom
//   lab_rejected_capacity             503 + Retry-After when the cluster is full
//   lab_request_authed                GET on the user's own lab: Traefik -> ForwardAuth
//                                     (/auth/verify) -> ttyd, i.e. what every terminal
//                                     request pays
// Cookies come from tests/load/run.sh (sessions minted in the API pod).
import http from "k6/http";
import { check } from "k6";
import { Counter, Trend } from "k6/metrics";

const BASE = __ENV.LABFORGE_URL || "http://host.docker.internal:8080";
const COOKIES = JSON.parse(open(__ENV.COOKIES_FILE || "/work/cookies.json"));
const AUTHED_REQUESTS = Number(__ENV.AUTHED_REQUESTS || 20);

const startWarm = new Trend("lab_start_warm", true);
const startCold = new Trend("lab_start_cold", true);
const authed = new Trend("lab_request_authed", true);
const created = new Counter("lab_created");
const rejectedCapacity = new Counter("lab_rejected_capacity");
const otherErrors = new Counter("lab_start_other_status");

export const options = {
  scenarios: {
    simultaneous_starts: {
      executor: "per-vu-iterations",
      vus: COOKIES.length, // one VU per user, all start together
      iterations: 1,
      maxDuration: "5m",
    },
  },
  summaryTrendStats: ["count", "min", "med", "p(95)", "max"],
};

export default function () {
  const cookie = COOKIES[__VU - 1];
  const headers = { cookie };

  const res = http.post(`${BASE}/api/labs`, null, { headers, timeout: "120s" });
  if (res.status === 503) {
    rejectedCapacity.add(1);
    check(res, { "503 carries Retry-After": (r) => r.headers["Retry-After"] === "60" });
    return;
  }
  if (res.status !== 201) {
    otherErrors.add(1);
    return;
  }
  created.add(1);
  const lab = res.json();
  (lab.startedFrom === "warm" ? startWarm : startCold).add(res.timings.duration);

  // The API returns localhost URLs; from inside this container the host is BASE.
  const path = new URL(lab.url).pathname;
  for (let i = 0; i < AUTHED_REQUESTS; i++) {
    const r = http.get(`${BASE}${path}token`, { headers });
    if (r.status === 200) authed.add(r.timings.duration);
  }
}
