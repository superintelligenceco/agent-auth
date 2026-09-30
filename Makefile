# Developer tasks. Run `make` to list them.
.DEFAULT_GOAL := help
.PHONY: help setup lint fmt typecheck test coverage bench build binaries docker docs docs-serve clean

VERSION := $(shell node -p 'require("./package.json").version')

help: ## List the available targets
	@awk 'BEGIN { FS = ":.*## " } /^[a-z-]+:.*## / { printf "  %-12s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

setup: ## Install dependencies and the pre-commit hooks
	npm ci
	npm --prefix docs ci
	@command -v pre-commit >/dev/null && pre-commit install || echo "pre-commit not found; skipping hook install"

lint: ## Lint and check formatting
	npm run lint
	npm run format:check

fmt: ## Format the code in place
	npx biome check --write .

typecheck: ## Type-check without emitting
	npm run typecheck

test: ## Run the unit, property and integration tests
	npm test

coverage: ## Run the tests with coverage
	npm run test:coverage

bench: ## Run the benchmarks and compare them with the committed baseline
	npm run bench

build: ## Compile TypeScript to dist/
	npm run build

binaries: ## Compile standalone executables into out/ (needs Bun)
	scripts/build-binaries.sh $(VERSION) out

docker: ## Build the container image as agent-auth:local
	docker build -t agent-auth:local .

docs: ## Build the documentation site into docs/.vitepress/dist
	npm --prefix docs run build

docs-serve: ## Serve the documentation site locally with live reload
	npm --prefix docs run dev

clean: ## Remove build output
	rm -rf dist out coverage reports docs/.vitepress/dist docs/.vitepress/cache
