.PHONY: dev build start typecheck lint smoke docker-up docker-down docker-logs clean

dev:
	npm run dev

build:
	npm run build

start:
	npm run start

typecheck:
	npm run typecheck

lint:
	npm run lint

smoke:
	npm run smoke

docker-up:
	docker compose up --build -d

docker-down:
	docker compose down

docker-logs:
	docker compose logs -f mcp-server

clean:
	rm -rf dist node_modules
