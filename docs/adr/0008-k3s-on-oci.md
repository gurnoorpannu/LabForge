# ADR-0008: Self-managed k3s on OCI Always Free, not a managed Kubernetes service

**Status:** accepted

## Context
Portfolio project: must cost nothing to keep running, and must exercise the operational work
SRE roles care about.

## Decision
Two OCI Ampere A1 VMs (Always Free: 4 OCPU / 24 GB total) provisioned with Terraform, k3s
installed and pinned with Ansible.

## Consequences
- **Free indefinitely**; managed control planes (EKS/GKE/AKS, even OKE's paid tiers) or their
  load balancers would not be.
- **The operational work is visible:** node hardening, OCI's host firewall quirks (its Ubuntu
  images REJECT all FORWARD traffic, which breaks pod networking until removed), kubelet
  configuration (PID limits, OOM behaviour), certificates, upgrades.
- **Trade-offs:** one k3s server is a single point of failure for the control plane (running
  labs keep working while it's down; nothing new can start). Local storage means Postgres
  lives on one node. Both are documented in failure-modes.md with what an HA version would
  need (3 servers with embedded etcd, managed Postgres or a replicated operator).
- Same k3s version runs locally in k3d, so everything is testable on a laptop first.
