// Lab isolation suite: attacks a lab from the inside (as the `lab` user, via
// kubectl exec) and asserts each attack fails. Skipped unless SECURITY=1.
//
//   make test-security                       # local k3d
//   SECURITY_REPORT=docs/security-report.md  # also write the table as markdown
//
// Targets (API server, nodes, other labs, CoreDNS, Traefik, platform services)
// are discovered from the live cluster, so the same suite runs on k3d and prod.
// Positive controls run the same probes from a pod WITHOUT a NetworkPolicy: if
// those don't connect, a "blocked" result proves nothing and the suite fails.
import { buildLab, createK8s, labNamespace, loadConfig, newLabId } from "@labforge/shared";
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const enabled = process.env.SECURITY === "1";
const PROBE_NS = "labforge-sectest";

interface Row {
  area: string;
  check: string;
  expected: string;
  observed: string;
  pass: boolean | null; // null = not applicable here
}
const rows: Row[] = [];

async function kubectl(args: string[], timeoutMs = 60_000) {
  try {
    const { stdout } = await run("kubectl", args, { timeout: timeoutMs, maxBuffer: 1 << 20 });
    return { code: 0, out: stdout.trim() };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string };
    return { code: typeof e.code === "number" ? e.code : 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() };
  }
}

/** kubectl <args...> -o jsonpath=<last arg>. */
const jsonpath = async (args: string[]) => {
  const expr = args[args.length - 1];
  return (await kubectl([...args.slice(0, -1), "-o", `jsonpath=${expr}`])).out;
};

/** Run a bash snippet inside a lab (as its container user, uid 1000). */
const inLab = (ns: string, script: string, timeoutMs = 60_000) =>
  kubectl(["-n", ns, "exec", "lab", "--", "bash", "-c", script], timeoutMs);
const inProbe = (script: string) => kubectl(["-n", PROBE_NS, "exec", "probe", "--", "bash", "-c", script]);

/** TCP connect within 4s. Works for any protocol; exit 0 = connected. */
const tcp = (host: string, port: number | string) =>
  `timeout 4 bash -c '</dev/tcp/${host}/${port}' 2>/dev/null && echo connected || echo refused-or-timeout`;

describe.skipIf(!enabled)("lab isolation (attacks from inside a lab)", () => {
  const k8s = createK8s();
  const cfg = loadConfig({
    DATABASE_URL: "postgres://unused",
    NODE_CIDR: "172.28.0.0/16",
    SESSION_SECRET: "x".repeat(32),
    ...process.env,
  });
  // a/b: network + privilege checks. mem/pids/disk: one throwaway lab per
  // destructive test, so one test's damage can't fail another.
  const lab = { a: newLabId(), b: newLabId(), mem: newLabId(), pids: newLabId(), disk: newLabId() };
  const ns = Object.fromEntries(Object.entries(lab).map(([k, id]) => [k, labNamespace(id)])) as Record<keyof typeof lab, string>;
  const t: Record<string, string> = {}; // discovered targets

  beforeAll(async () => {
    // Throwaway labs built exactly like real ones (warm = no ingress; network
    // policy, pod security and limits are identical).
    for (const id of Object.values(lab)) {
      await k8s.applyLab(buildLab(cfg, { labId: id, state: "ready" }));
    }
    // A plain pod with no NetworkPolicy, for positive controls.
    await kubectl(["create", "namespace", PROBE_NS]);
    await kubectl([
      "-n", PROBE_NS, "run", "probe", `--image=${cfg.lab.image}`, "--image-pull-policy=IfNotPresent",
      "--restart=Never", "--command", "--", "sleep", "1800",
    ]);
    for (const id of Object.values(lab)) expect(await k8s.waitForPodReady(id, 120_000)).toBe(true);
    await kubectl(["-n", PROBE_NS, "wait", "--for=condition=Ready", "pod/probe", "--timeout=120s"]);

    t.apiClusterIp = await jsonpath(["-n", "default", "get", "svc", "kubernetes", "{.spec.clusterIP}"]);
    t.nodeIps = await jsonpath(["get", "nodes", '{range .items[*]}{.status.addresses[?(@.type=="InternalIP")].address} {end}']);
    t.labBPod = await jsonpath(["-n", ns.b, "get", "pod", "lab", "{.status.podIP}"]);
    t.labBSvc = await jsonpath(["-n", ns.b, "get", "svc", "lab", "{.spec.clusterIP}"]);
    t.traefikPod = await jsonpath(["-n", "kube-system", "get", "pods", "-l", "app.kubernetes.io/name=traefik", "{.items[0].status.podIP}"]);
    t.traefikPort = await jsonpath(["-n", "kube-system", "get", "pods", "-l", "app.kubernetes.io/name=traefik", "{.items[0].spec.containers[0].ports[0].containerPort}"]);
    t.dnsPod = await jsonpath(["-n", "kube-system", "get", "pods", "-l", "k8s-app=kube-dns", "{.items[0].status.podIP}"]);
    // Platform services (API, Postgres) exist once deployed with the Helm chart.
    t.platform = await jsonpath(["-n", "labforge", "get", "svc", '{range .items[*]}{.metadata.name}={.spec.clusterIP}:{.spec.ports[0].port} {end}']);
  }, 300_000);

  afterAll(async () => {
    for (const id of Object.values(lab)) await k8s.deleteLab(id).catch(() => {});
    await kubectl(["delete", "namespace", PROBE_NS, "--wait=false"]);
    printReport();
  });

  /** Record a row; `pass` is asserted at the end so every row gets printed. */
  const record = (r: Row) => {
    rows.push(r);
    if (r.pass !== null) expect(r.pass, `${r.area}: ${r.check} (observed: ${r.observed})`).toBe(true);
  };

  /** From lab A must fail; from the policy-free probe must succeed. */
  async function blocked(area: string, check: string, host: string, port: number | string) {
    const fromLab = (await inLab(ns.a, tcp(host, port))).out;
    const fromProbe = (await inProbe(tcp(host, port))).out;
    record({
      area,
      check: `${check} (${host}:${port})`,
      expected: "blocked (reachable without the policy)",
      observed: `lab: ${fromLab}; control: ${fromProbe}`,
      pass: fromLab !== "connected" && fromProbe === "connected",
    });
  }

  // --- network: lateral movement and control plane -----------------------------

  it("cannot reach the Kubernetes API via its ClusterIP", () => blocked("network", "K8s API ClusterIP", t.apiClusterIp!, 443));

  it("cannot reach the Kubernetes API or kubelet on any node", async () => {
    const nodes = t.nodeIps!.split(" ").filter(Boolean);
    expect(nodes.length).toBeGreaterThan(0);
    await blocked("network", "K8s API on server node", nodes[nodes.length - 1]!, 6443);
    for (const ip of nodes) await blocked("network", "kubelet on node", ip, 10250);
  });

  it("cannot reach another lab's pod or service", async () => {
    // Labs only accept Traefik, so the policy-free probe is refused too: control
    // here is "Traefik-less paths are refused for everyone", checked below.
    for (const [what, host] of [["pod", t.labBPod!], ["service", t.labBSvc!]] as const) {
      const fromLab = (await inLab(ns.a, tcp(host, 7681))).out;
      const fromProbe = (await inProbe(tcp(host, 7681))).out;
      record({
        area: "network",
        check: `another lab's ${what} (${host}:7681)`,
        expected: "blocked, also for non-Traefik pods",
        observed: `lab: ${fromLab}; other pod: ${fromProbe}`,
        pass: fromLab !== "connected" && fromProbe !== "connected",
      });
    }
  });

  it("cannot reach Traefik's pod directly", () => blocked("network", "Traefik pod", t.traefikPod!, t.traefikPort!));

  it("reaches CoreDNS on port 53 only (not its metrics port)", async () => {
    const dns53 = (await inLab(ns.a, tcp(t.dnsPod!, 53))).out;
    record({ area: "network", check: `CoreDNS ${t.dnsPod}:53`, expected: "allowed", observed: dns53, pass: dns53 === "connected" });
    await blocked("network", "CoreDNS metrics", t.dnsPod!, 9153);
  });

  it("cannot reach the cloud metadata service", async () => {
    const fromLab = (await inLab(ns.a, tcp("169.254.169.254", 80))).out;
    record({
      area: "network",
      check: "cloud metadata (169.254.169.254:80)",
      expected: "blocked",
      observed: fromLab,
      pass: fromLab !== "connected",
    });
  });

  it("cannot reach platform services (API, Postgres) directly", async () => {
    const services = t.platform!.split(" ").filter(Boolean);
    if (services.length === 0) {
      rows.push({ area: "network", check: "platform services in ns labforge", expected: "blocked", observed: "none deployed here", pass: null });
      return;
    }
    for (const s of services) {
      const [name, addr] = s.split("=") as [string, string];
      const [host, port] = addr.split(":") as [string, string];
      await blocked("network", `platform service ${name}`, host, port);
    }
  });

  it("other workloads in the cluster cannot reach a lab (only Traefik can)", async () => {
    const res = (await inProbe(tcp(t.labBPod!, 7681))).out;
    record({ area: "network", check: "non-Traefik pod -> lab :7681", expected: "blocked", observed: res, pass: res !== "connected" });
  });

  // --- network: what a lab IS allowed ----------------------------------------------

  it("resolves DNS and reaches the internet (egress enabled)", async () => {
    const dns = await inLab(ns.a, "getent hosts example.com >/dev/null && echo ok");
    record({ area: "egress", check: "DNS lookup", expected: "allowed", observed: dns.out || "failed", pass: dns.out === "ok" });
    const https = await inLab(ns.a, "curl -s -o /dev/null -m 10 -w '%{http_code}' https://example.com");
    record({ area: "egress", check: "HTTPS to the internet", expected: "allowed", observed: `HTTP ${https.out}`, pass: https.out.startsWith("2") || https.out.startsWith("3") });
    const ping = await inLab(ns.a, "ping -c1 -W3 1.1.1.1 >/dev/null && echo ok");
    record({ area: "egress", check: "ping (ICMP) without CAP_NET_RAW", expected: "allowed", observed: ping.out || "failed", pass: ping.out === "ok" });
  });

  // --- privilege ---------------------------------------------------------------------

  it("runs as the unprivileged lab user and cannot become root", async () => {
    const id = (await inLab(ns.a, "id -u")).out;
    record({ area: "privilege", check: "runs as uid 1000", expected: "uid 1000", observed: `uid ${id}`, pass: id === "1000" });
    const su = await inLab(ns.a, "su -c true root </dev/null >/dev/null 2>&1 && echo root || echo denied");
    record({ area: "privilege", check: "su to root", expected: "denied", observed: su.out, pass: su.out === "denied" });
    const sudo = await inLab(ns.a, "command -v sudo || echo absent");
    record({ area: "privilege", check: "sudo binary", expected: "absent", observed: sudo.out, pass: sudo.out === "absent" });
  });

  it("has no capabilities, no_new_privs, and a seccomp filter", async () => {
    const st = (await inLab(ns.a, "grep -E '^(CapEff|CapBnd|NoNewPrivs|Seccomp):' /proc/self/status")).out;
    const field = (k: string) => st.match(new RegExp(`${k}:\\s*(\\S+)`))?.[1] ?? "?";
    for (const [k, want] of [["CapEff", "0000000000000000"], ["CapBnd", "0000000000000000"], ["NoNewPrivs", "1"], ["Seccomp", "2"]] as const) {
      record({ area: "privilege", check: `${k}`, expected: want, observed: field(k), pass: field(k) === want });
    }
  });

  it("cannot create namespaces or mount filesystems (container escape primitives)", async () => {
    const uns = await inLab(ns.a, "unshare -r true 2>/dev/null && echo created || echo denied");
    record({ area: "privilege", check: "unshare (new user namespace)", expected: "denied", observed: uns.out, pass: uns.out === "denied" });
    const mnt = await inLab(ns.a, "mount -t tmpfs none /tmp 2>/dev/null && echo mounted || echo denied");
    record({ area: "privilege", check: "mount a filesystem", expected: "denied", observed: mnt.out, pass: mnt.out === "denied" });
    const tok = await inLab(ns.a, "ls /var/run/secrets/kubernetes.io/serviceaccount 2>/dev/null && echo present || echo absent");
    record({ area: "privilege", check: "service account token", expected: "absent", observed: tok.out, pass: tok.out === "absent" });
  });

  // --- filesystem --------------------------------------------------------------------

  it("can write only to /home/lab and /tmp", async () => {
    for (const path of ["/nope", "/etc/passwd", "/usr/local/bin/x", "/etc/labforge/expires-at"]) {
      const r = await inLab(ns.a, `( echo x >> ${path} ) 2>/dev/null && echo written || echo refused`);
      record({ area: "filesystem", check: `write ${path}`, expected: "refused", observed: r.out, pass: r.out === "refused" });
    }
    for (const path of ["/home/lab/ok", "/tmp/ok"]) {
      const r = await inLab(ns.a, `echo x > ${path} && echo written || echo refused`);
      record({ area: "filesystem", check: `write ${path}`, expected: "written", observed: r.out, pass: r.out === "written" });
    }
  });

  // --- resource limits ----------------------------------------------------------------

  it("caps memory: the process that overruns is OOM-killed, the lab survives", async () => {
    const r = await inLab(ns.mem, "python3 -c \"b = b'x' * (700 * 1024 * 1024)\" ; echo exit=$?");
    // 137 = SIGKILL. "exit=137" means only python died; a bare 137 from kubectl
    // means the whole container was killed (no singleProcessOOMKill).
    record({ area: "limits", check: "allocate 700Mi (limit 512Mi)", expected: "OOM-killed (137)", observed: r.out.split("\n").pop() ?? r.out, pass: r.out.includes("137") });
    const alive = (await inLab(ns.mem, "echo alive")).out;
    record({ area: "limits", check: "lab survives its own OOM (singleProcessOOMKill)", expected: "alive", observed: alive, pass: alive === "alive" });
  });

  it("caps processes: a fork bomb stops at the pod PID limit", async () => {
    // Fork children that exec `sleep` until fork fails; report how many started.
    const py = [
      "import os",
      "n = 0; kids = []",
      "try:",
      "    while n < 3000:",
      "        p = os.fork()",
      "        if p == 0: os.execv('/bin/sleep', ['sleep', '60'])",
      "        kids.append(p); n += 1",
      "except OSError as e: pass",
      "print(n)",
      "[os.kill(k, 9) for k in kids]",
    ].join("\n");
    const r = await inLab(ns.pids, `python3 -c "${py}"`, 120_000);
    const started = Number(r.out.split("\n").pop());
    record({
      area: "limits",
      check: "fork bomb (3000 processes requested)",
      expected: "stopped below the 1024 pod limit",
      observed: Number.isFinite(started) ? `${started} started, then fork failed` : r.out,
      pass: Number.isFinite(started) && started > 0 && started < 1024,
    });
    // The killed children are orphans now; PID 1 (tini) must reap them or they
    // hold PIDs forever. Give it a few seconds, then the lab must fork again.
    let alive = "";
    for (let i = 0; i < 10 && alive !== "alive"; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      alive = (await inLab(ns.pids, "echo alive")).out;
    }
    record({ area: "limits", check: "lab usable after fork bomb (orphans reaped)", expected: "alive", observed: alive.slice(0, 80), pass: alive === "alive" });
    const procs = (await inLab(ns.pids, "ps -e --no-headers | wc -l")).out;
    record({ area: "limits", check: "processes left after fork bomb", expected: "a handful (no zombies)", observed: procs, pass: Number(procs) < 20 });
  }, 180_000);

  it("caps disk: filling past ephemeral-storage gets the lab evicted", async () => {
    await inLab(ns.disk, "dd if=/dev/zero of=/home/lab/fill bs=1M count=700 2>/dev/null; echo done", 120_000);
    // The kubelet's eviction manager checks usage periodically (~1 min on k3d).
    // On 1.35 the evicted pod ends "Succeeded" with no status.reason, so read the event.
    let evicted = "";
    for (let i = 0; i < 60 && !evicted; i++) {
      evicted = await jsonpath(["-n", ns.disk, "get", "events", "--field-selector", "involvedObject.name=lab,reason=Evicted", "{.items[*].message}"]);
      if (!evicted) await new Promise((r) => setTimeout(r, 3000));
    }
    record({ area: "limits", check: "write 700Mi to /home/lab (limit 512Mi)", expected: "pod evicted", observed: evicted || "not evicted after 3 min", pass: evicted.startsWith("Pod ephemeral local storage") });
  }, 300_000);
});

function printReport() {
  if (rows.length === 0) return;
  const mark = (p: boolean | null) => (p === null ? "n/a" : p ? "PASS" : "FAIL");
  const lines = [
    "| Result | Area | Check | Expected | Observed |",
    "|---|---|---|---|---|",
    ...rows.map((r) => `| ${mark(r.pass)} | ${r.area} | ${r.check} | ${r.expected} | ${r.observed.replace(/\|/g, "/")} |`),
  ];
  const passed = rows.filter((r) => r.pass === true).length;
  const failed = rows.filter((r) => r.pass === false).length;
  const summary = `${passed} passed, ${failed} failed, ${rows.length - passed - failed} n/a`;
  console.log(`\nLab isolation report: ${summary}\n${lines.join("\n")}\n`);
  if (process.env.SECURITY_REPORT) {
    const ctx = process.env.SECURITY_CONTEXT ?? "";
    writeFileSync(
      process.env.SECURITY_REPORT,
      `# Lab isolation report\n\n${ctx}\n\n**${summary}.** Generated by \`make test-security\` (tests/security/isolation.test.ts) on ${new Date().toISOString()}.\n\n${lines.join("\n")}\n`,
    );
  }
}
