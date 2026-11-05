.DEFAULT_GOAL := help
.PHONY: help install typecheck lint test test-integration dev-up dev-down dev-db dev-db-down \
        api-run mint-session test-security test-e2e load-test images images-import chart-up chart-down up lab-image lab-image-import lab-example-up lab-example-down infra-init infra-plan infra-apply provision bootstrap

# --- Local dev config ---
# (Comments go on their own line: Make keeps the spaces before a trailing `#`
#  as part of the value.)
CLUSTER      ?= labforge
LAB_IMAGE    ?= labforge-lab:dev
# Host port mapped to the cluster load balancer's :80
HTTP_PORT    ?= 8080
# Docker network for the k3d nodes, pinned so the labs' NetworkPolicy can block it
# (the API server's ClusterIP resolves to a node IP in here). Keep in sync with
# NODE_CIDR in services/api/.env and deploy/local/lab-example.yaml.
NODE_CIDR    ?= 172.28.0.0/16
# Host port for the dev Postgres (override if 5432 is taken: make dev-db DB_PORT=5433)
DB_PORT      ?= 5432
DATABASE_URL ?= postgres://labforge:labforge@localhost:$(DB_PORT)/labforge
# Lab id of the hand-written example in deploy/local/lab-example.yaml
EXAMPLE_ID   ?= demo0lab0one

## help: Show this help
help:
	@echo "LabForge — available targets:"
	@grep -E '^## [a-zA-Z0-9_-]+:' $(MAKEFILE_LIST) | sed 's/## /  /' | sort

## install: Install JS dependencies for all workspaces
install:
	npm install

## typecheck: Type-check all TypeScript workspaces
typecheck:
	npm run typecheck

## lint: Lint all code
lint:
	npm run lint

## test: Run unit tests
test:
	npm test

## test-integration: Run integration tests against k3d + dev-db (needs dev-up, dev-db, lab image)
test-integration:
	@# One file at a time: they share the dev database and the cluster.
	INTEGRATION=1 DATABASE_URL=$(DATABASE_URL) NODE_CIDR=$(NODE_CIDR) \
	  npx vitest run tests/integration --no-file-parallelism

## test-security: Lab isolation suite against the current cluster (SECURITY_REPORT=file to save the table)
test-security:
	SECURITY=1 NODE_CIDR=$(NODE_CIDR) npx vitest run tests/security

## dev-db: Start a local Postgres 16 in Docker on :$(DB_PORT)
dev-db:
	docker run -d --name labforge-db -p $(DB_PORT):5432 \
	  -e POSTGRES_USER=labforge -e POSTGRES_PASSWORD=labforge -e POSTGRES_DB=labforge \
	  postgres:16

## dev-db-down: Remove the local Postgres container
dev-db-down:
	docker rm -f labforge-db

## api-run: Build and run the API on the host against k3d (uses services/api/.env)
api-run:
	npm run typecheck
	node --env-file=services/api/.env services/api/dist/index.js

## mint-session: Print a session Cookie header for LAB_USER (no Google needed), e.g. make mint-session LAB_USER=alice
mint-session:
	@test -n "$(LAB_USER)" || (echo "usage: make mint-session LAB_USER=<id>" && exit 2)
	@npm run typecheck >/dev/null
	@node --env-file=services/api/.env services/api/dist/mint-session.js $(LAB_USER)

## dev-up: Create local k3d cluster (k3s + bundled Traefik), map :$(HTTP_PORT)->:80
dev-up:
	k3d cluster create $(CLUSTER) \
	  --servers 1 --agents 1 \
	  --subnet $(NODE_CIDR) \
	  --volume "$(CURDIR)/infra/kubelet/10-labforge.conf:/var/lib/rancher/k3s/agent/etc/kubelet.conf.d/10-labforge.conf@server:*;agent:*" \
	  -p "$(HTTP_PORT):80@loadbalancer" \
	  --wait
	kubectl cluster-info

## dev-down: Delete the local k3d cluster
dev-down:
	k3d cluster delete $(CLUSTER)

## images: Build all four images for the local (arm64) node, tagged :dev
images: lab-image
	for s in api pool-controller reaper; do \
	  docker buildx build --platform linux/arm64 -f services/Dockerfile --build-arg SERVICE=$$s -t labforge-$$s:dev --load . ; \
	done

## images-import: Load all four :dev images into the k3d cluster
images-import:
	k3d image import labforge-lab:dev labforge-api:dev labforge-pool-controller:dev labforge-reaper:dev -c $(CLUSTER)

## chart-up: Install/upgrade the Helm chart on k3d (values-local.yaml; EXTRA_VALUES=file to layer more)
chart-up:
	kubectl create namespace labforge --dry-run=client -o yaml | kubectl apply -f -
	kubectl label namespace labforge pod-security.kubernetes.io/enforce=restricted --overwrite
	helm upgrade --install labforge deploy/helm/labforge -n labforge \
	  -f deploy/helm/labforge/values-local.yaml $(if $(EXTRA_VALUES),-f $(EXTRA_VALUES)) --wait --timeout 5m

## chart-down: Uninstall the chart (keeps the Postgres PVC)
chart-down:
	helm uninstall labforge -n labforge

## up: Fresh local stack from scratch: k3d cluster + images + chart
up: dev-up images images-import chart-up

## test-e2e: End-to-end through Traefik against the chart on k3d (installs values-e2e.yaml: TTL 2m)
test-e2e:
	$(MAKE) chart-up EXTRA_VALUES=deploy/helm/labforge/values-e2e.yaml
	E2E=1 LABFORGE_URL=http://localhost:$(HTTP_PORT) npx vitest run tests/e2e

## load-test: k6: USERS start labs at once (default 10); OUT=file keeps the k6 summary
USERS ?= 10
load-test:
	tests/load/run.sh $(USERS) $(OUT)

## lab-image: Build the lab terminal image for the local (arm64) node
lab-image:
	docker buildx build --platform linux/arm64 -t $(LAB_IMAGE) --load images/lab

## lab-image-import: Load the locally built lab image into the k3d cluster
lab-image-import:
	k3d image import $(LAB_IMAGE) -c $(CLUSTER)

## lab-example-up: Apply the hand-written example lab namespace
lab-example-up:
	kubectl apply -f deploy/local/lab-example.yaml
	@echo "Open: http://localhost:$(HTTP_PORT)/lab/$(EXAMPLE_ID)"

## lab-example-down: Delete the hand-written example lab namespace
lab-example-down:
	kubectl delete -f deploy/local/lab-example.yaml --ignore-not-found

TF := terraform -chdir=infra/terraform

## infra-init: terraform init with the OCI Object Storage backend (needs infra/terraform/backend.hcl)
infra-init:
	$(TF) init -backend-config=backend.hcl

## infra-plan: terraform plan for OCI, saved to tfplan (read-only, costs nothing)
infra-plan:
	$(TF) plan -out=tfplan

## infra-apply: Create the OCI resources from the reviewed tfplan (you run this)
infra-apply:
	@echo "Applying the saved plan in infra/terraform/tfplan (review it first: make infra-plan)."
	$(TF) apply tfplan

## provision: Harden the nodes and install k3s with Ansible (after infra-apply)
provision:
	cd infra/ansible && ansible-playbook site.yml

## bootstrap: Install Argo CD on the cluster in KUBECONFIG, then the LabForge Applications
bootstrap:
	helm repo add argo https://argoproj.github.io/argo-helm >/dev/null
	helm upgrade --install argocd argo/argo-cd --version 10.14.0 -n argocd --create-namespace --wait
	kubectl apply -f deploy/argocd/cluster.yaml -f deploy/argocd/monitoring.yaml -f deploy/argocd/application.yaml
