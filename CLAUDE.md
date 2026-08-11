# CLAUDE.md

Guidance for AI agents working in this repo.

## What this is

ConfigManager — a Redis-backed configuration management system. Three components:

- **ConfigManager.Api/** — Node.js/Express REST API. The only writer to Redis. Keys follow `<project>:<namespace>:<setting>`. Writes are an atomic pipeline of `SET` + `PUBLISH` (real-time pub/sub) + `SADD config:projects <project>`.
- **ConfigManager.Web/** — Vue 3 + Vite + TypeScript UI for browsing/editing configs.
- **ConfigManager.Provider** — .NET provider. **Lives in a separate OSS repo**, consumed via NuGet. Not in this monorepo.

## Layout

```
.
├── ConfigManager.Api/            # REST API (Node, ioredis, Express, jest)
│   ├── src/
│   │   ├── index.js              # app entry, middleware, route mounting, graceful shutdown
│   │   ├── routes/config.js      # /redis/:key  (GET/POST/PUT/DELETE) + /redis/:key/children
│   │   ├── routes/projects.js    # /projects, /projects/:project/configs, /projects/migrate
│   │   └── services/redis.js     # Redis access, key model, type inference, conflict detection
│   └── tests/                    # jest; needs Redis (flushes db 15 per test)
├── ConfigManager.Web/            # UI (Vue 3, Vite, vitest)
├── shared/                       # cross-component contract fixtures (config-type-cases.json)
├── docs/architecture.md          # data model + component flow
└── .github/workflows/            # path-filtered CI: ci-api.yml, ci-web.yml
```

## Key model

- Format: `<project>:<namespace>:<setting>` (namespace is multi-level), e.g. `newwords.api:config:nlog:minlevel`.
- Values stored as **strings**; the Api infers type on read (`integer`, `float`, `boolean`, `loglevel`, `array`, `object`, `string`, `null`) and returns both raw `value` and `parsedValue`.
- The inference rules are duplicated in `ConfigManager.Web/src/utils/ConfigTypeInference.ts` and locked to the Api by `shared/config-type-cases.json`, asserted by both suites. Change one implementation and you must change the other — the accepted forms per type are in `docs/architecture.md`.
- Write pipeline: `SET key value` + `PUBLISH key value` + `SADD config:projects <project>`.
- Delete: `DEL key` + `PUBLISH key __DELETED__`; namespace delete scans children with `SCAN` (never `KEYS` in prod paths).
- Conflict detection rejects keys colliding with an existing parent (`parent_exists`) or shadowing existing children (`children_exist`).

## Api routes (mounted in `src/index.js`)

- `GET /health`
- `GET /projects` · `GET /projects/:project/configs` · `POST /projects/migrate`
- `GET|POST|PUT|DELETE /redis/:key` · `DELETE /redis/:key/children`

## Working in this repo

- Api tests need Redis. From `ConfigManager.Api/`: `npm ci && npm test` with `TEST_REDIS_URL=redis://127.0.0.1:6379/15` (the suite flushes db 15 before each test).
- Web tests: `cd ConfigManager.Web && npm ci && npm run test:ci` (vitest).
- CI is path-filtered — Api changes don't build Web and vice versa.
- Keep `.github/workflows/` at the repo root (GitHub reads workflows only from `<root>/.github/workflows/`).
- When moving component files, move them under their `ConfigManager.<Component>/` directory and update the corresponding workflow's `paths:` + `working-directory`.
