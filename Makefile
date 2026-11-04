.DEFAULT_GOAL := help
.PHONY: help install typecheck lint test test-integration dev-up dev-down dev-db dev-db-down \
        rbac api-run lab-image lab-image-import lab-example-up lab-example-down infra-plan

# --- Local dev config ---
CLUSTER      ?= labforge
LAB_IMAGE    ?= labforge-lab:dev
HTTP_PORT    ?= 8080            # host port -> cluster loadbalancer :80
EXAMPLE_ID   ?= demo0lab0one    # >=12 url-safe chars, matches lab-example

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
	INTEGRATION=1 npx vitest run tests/integration

## dev-db: Start a local Postgres 16 in Docker on :5432
dev-db:
	docker run -d --name labforge-db -p 5432:5432 \
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

## dev-up: Create local k3d cluster (k3s + bundled Traefik), map :$(HTTP_PORT)->:80
dev-up:
	k3d cluster create $(CLUSTER) \
	  --servers 1 --agents 1 \
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
