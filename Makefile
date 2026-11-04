.DEFAULT_GOAL := help
.PHONY: help install typecheck lint test test-integration dev-up dev-down dev-db dev-db-down \
        rbac api-run mint-session lab-image lab-image-import lab-example-up lab-example-down infra-plan

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
	@grep -E '^## [a-zA-Z_-]+:' $(MAKEFILE_LIST) | sed 's/## /  /' | sort

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

## dev-db: Start a local Postgres 16 in Docker on :$(DB_PORT)
dev-db:
	docker run -d --name labforge-db -p $(DB_PORT):5432 \
	  -e POSTGRES_USER=labforge -e POSTGRES_PASSWORD=labforge -e POSTGRES_DB=labforge \
	  postgres:16

## dev-db-down: Remove the local Postgres container
dev-db-down:
	docker rm -f labforge-db

## rbac: Apply the API ServiceAccount + least-privilege ClusterRole
rbac:
	kubectl apply -f deploy/local/rbac.yaml

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
	  -p "$(HTTP_PORT):80@loadbalancer" \
	  --wait
	kubectl cluster-info

## dev-down: Delete the local k3d cluster
dev-down:
	k3d cluster delete $(CLUSTER)

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

## infra-plan: terraform plan for OCI (Phase 8, never applies without confirmation)
infra-plan:
	@echo "TODO(Phase 8): terraform plan"
