# Architecture

## Overview

ConfigManager stores application configuration in Redis and propagates changes in real time over pub/sub. Three components collaborate:

```
┌───────────────────┐   read/write     ┌──────────────┐    ┌──────────────────────┐
│ ConfigManager.Web │ ───────────────▶ │ ConfigManager│ ◀──│ ConfigManager.Provider│
│ (Vue UI)          │                  │ .Api (Node)  │    │ (.NET app, via NuGet) │
└───────────────────┘                  └──────┬───────┘    └──────────────────────┘
                                              │ ioredis
                                              ▼
                                       ┌──────────────┐
                                       │    Redis     │  keys: <project>:<namespace>:<setting>
                                       └──────────────┘
```

The Api is the only writer. Web and Provider subscribe to Redis pub/sub channels (keyed by the config key) to receive live updates.

## Key / data model

Every configuration value is a Redis string keyed by `<project>:<namespace>:<setting>`:

| Segment    | Meaning                            | Example        |
|------------|------------------------------------|----------------|
| `project`  | Consuming application / tenant     | `newwords.api` |
| `namespace`| Logical group (multi-level)        | `config:nlog`  |
| `setting`  | Leaf setting                       | `minlevel`     |

Full example: `newwords.api:config:nlog:minlevel` → `"Debug"`.

- **Project registry** — on every write the Api does `SADD config:projects <project>`, so `GET /projects` is O(1). `POST /projects/migrate` backfills this set from existing keys.
- **Type inference** — values are stored as strings; the Api infers the type on read and returns both the raw `value` and a derived `parsedValue`. See [Type inference contract](#type-inference-contract).
- **Real-time** — writes pipeline `SET` + `PUBLISH` atomically; deletes `PUBLISH` the sentinel `__DELETED__`.
- **Conflict detection** — rejects a key that collides with an existing parent (`parent_exists`) or that would shadow existing children (`children_exist`).

## Type inference contract

Every value is stored in Redis as a string. Both the Api
(`ConfigManager.Api/src/services/redis.js`) and the Web
(`ConfigManager.Web/src/utils/ConfigTypeInference.ts`) classify that string with the same
rules, in this precedence order, and derive the same `parsedValue`. The stored `value` is
never rewritten — only the derived `parsedValue` normalises.

| Type       | Accepted form                                          | `parsedValue`            |
|------------|--------------------------------------------------------|--------------------------|
| `loglevel` | `trace`, `debug`, `info`, `warn`, `error`, `fatal` (any case) | the value **lowercased** (`INFO` → `"info"`) |
| `integer`  | `/^-?(0\|[1-9]\d*)$/`                                   | the number (`-1` → `-1`) |
| `float`    | `/^-?(0\|[1-9]\d*)(\.\d+([eE][+-]?\d+)?\|[eE][+-]?\d+)$/` | the number (`1e3` → `1000`) |
| `boolean`  | `true` / `false` (any case)                            | `true` / `false`         |
| `array`    | parses as a JSON array                                 | the parsed array         |
| `object`   | parses as a non-null JSON object                       | the parsed object        |
| `null`     | the value is absent (`null` / `undefined`)             | `null`                   |
| `string`   | anything else                                          | the stored string        |

Numbers follow the JSON number grammar. Consequences worth knowing:

- A leading `-` and exponent notation are accepted: `-1` (the conventional "unlimited"
  value), `-2.5` and `-1.5e-3` are numeric, not strings.
- Zero-padded forms stay `string`, so a file mode such as `007` round-trips intact instead
  of being reported as `7`. `0` itself is an `integer`.
- Spellings JSON rejects stay `string`: `.5`, `1.`, `+1`, `0x1f`.

The two implementations are locked to each other by `shared/config-type-cases.json`, a
`value → (type, parsedValue)` table asserted by both the Api jest suite
(`tests/services/config-type-inference.test.js`) and the Web vitest suite
(`src/utils/__tests__/ConfigTypeInference.test.ts`). Changing one implementation fails its own
suite; updating the shared table to match then fails the other component's suite until that
side is changed too. Both workflows watch `shared/**` so an edit to the table alone still
runs both.

## Api surface

Mounted in `src/index.js`:

- `GET /health`
- `GET /projects` — registered projects.
- `GET /projects/:project/configs` — all configs for a project, grouped by namespace, with inferred types.
- `POST /projects/migrate` — backfill `config:projects` from existing keys.
- `GET /redis/:key` — read one value.
- `POST /redis/:key` — create (atomic set + publish + register project; guards: key-exists + naming-conflict).
- `PUT /redis/:key` — update.
- `DELETE /redis/:key` — delete + publish `__DELETED__`.
- `DELETE /redis/:key/children` — delete all keys under a namespace (preserves the parent key).

## Provider boundary

`ConfigManager.Provider` is **not** part of this monorepo. It remains a standalone OSS repo consumed via NuGet, keeping the OSS ↔ possibly-commercial boundary as a repo boundary (future commercialization of Api/Web needs no license/history untangling).
