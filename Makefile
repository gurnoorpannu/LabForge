.DEFAULT_GOAL := help
.PHONY: help install typecheck lint test dev-up dev-down lab-image infra-plan

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

## dev-up: Create local k3d cluster (Phase 1)
dev-up:
	@echo "TODO(Phase 1): create k3d cluster"

## dev-down: Tear down local k3d cluster (Phase 1)
dev-down:
	@echo "TODO(Phase 1): delete k3d cluster"

## lab-image: Build the lab terminal image (Phase 1)
lab-image:
	@echo "TODO(Phase 1): docker buildx the lab image"

## infra-plan: terraform plan for OCI (Phase 8, never applies without confirmation)
infra-plan:
	@echo "TODO(Phase 8): terraform plan"
