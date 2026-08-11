# ConfigManager.Api

A lightweight REST API for Redis-based configuration management with real-time updates and project isolation.

> Part of the [ConfigManager ecosystem](../README.md) - providing the backend API for configuration management.

## Features

- **GET /redis/:key** - Retrieve configuration values
- **POST /redis/:key** - Set configuration values (atomic SET + PUBLISH)
- **Health Check** - `/health` endpoint for service monitoring
- **Error Handling** - Comprehensive error responses
- **CORS Support** - Cross-origin requests enabled

## Quick Start

### Prerequisites
- Node.js 18+
- Redis server running (default: localhost:6379)

### Installation
```bash
cd ConfigManager.Api
npm install
```

### Configuration
```bash
# Copy environment template
cp .env.example .env

# Edit configuration (optional)
# Default values work for local development
```

### Development
```bash
# Start in development mode (with auto-reload)
npm run dev

# Or start normally
npm start
```

### Testing
```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage
```

## API Usage

### Key Format

Configuration keys follow the `<project>:<namespace>:<setting>` model and may only
contain letters, digits and the characters `.`, `_`, `:` and `-`
(`^[a-zA-Z0-9._:-]+$`). Any other character — notably the Redis glob
metacharacters `*`, `?` and `[` — is rejected with `400 Bad Request` on every
`/redis/:key` route, including `DELETE /redis/:key/children`:

```json
{
  "error": "Bad Request",
  "message": "Invalid key format: only letters, digits and the characters . _ : - are allowed"
}
```

The same allowlist applies to the `:project` parameter of
`GET /projects/:project/configs`.

### Health Check
```bash
curl http://localhost:3001/health
```

### Get Configuration
```bash
curl http://localhost:3001/redis/newwords.api:config:nlog:minlevel
```

### Set Configuration
```bash
curl -X POST http://localhost:3001/redis/newwords.api:config:nlog:minlevel \
  -H "Content-Type: application/json" \
  -d '{"value": "Debug"}'
```

## Testing with NewWords.Api

1. **Start ConfigManager.Api**:
   ```bash
   cd ConfigManager.Api
   npm run dev
   ```

2. **Set a configuration**:
   ```bash
   curl -X POST http://localhost:3001/redis/newwords.api:config:nlog:minlevel \
     -H "Content-Type: application/json" \
     -d '{"value": "Debug"}'
   ```

3. **Verify in NewWords.Api logs** - You should see the configuration change take effect and DEBUG messages appear.

4. **Get current value**:
   ```bash
   curl http://localhost:3001/redis/newwords.api:config:nlog:minlevel
   ```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3001 | HTTP server port |
| `REDIS_URL` | redis://localhost:6379 | Redis connection URL |
| `CORS_ORIGIN` | http://localhost:3000 | Allowed CORS origin |
| `NODE_ENV` | development | Environment mode |
| `LOG_LEVEL` | info | Logging level (error, warn, info, debug) |
| `SEQ_URL` | - | Optional: Seq server URL for structured logging |
| `SEQ_API_KEY` | - | Optional: Seq API key for authentication |

## Logging

ConfigManager supports two logging modes:

### Console Logging (Default)
When no `SEQ_URL` is provided, the service uses pretty-formatted console logging ideal for development:

```bash
[2025-09-20 16:28:20.301 +1200] INFO: ConfigManager.Api started
    port: "3001"
    environment: "development"
    healthCheck: "http://localhost:3001/health"
```

### Structured Logging to Seq
When `SEQ_URL` is configured, the service sends structured logs to your Seq server:

```bash
# Enable Seq logging
SEQ_URL=http://your-seq-server:5341
SEQ_API_KEY=your_optional_api_key
```

This provides powerful log analysis, searching, and alerting capabilities through Seq's web interface.

## API Response Format

### Success Response
```json
{
  "success": true,
  "key": "newwords.api:config:nlog:minlevel",
  "value": "Debug",
  "operations": {
    "set": true,
    "published": 1
  }
}
```

### Error Response
```json
{
  "error": "Bad Request",
  "message": "Value is required in request body"
}
```

### Inferred Value Types

Values are stored in Redis as strings. Reads report the raw `value` plus a `type` and a
derived `parsedValue`. The stored `value` is never rewritten — only `parsedValue` normalises.
Classification runs in this precedence order:

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

Numbers follow the JSON number grammar, so `-1`, `-2.5` and `1e3` are numeric, while
zero-padded forms (`007`) and spellings JSON rejects (`.5`, `1.`, `+1`, `0x1f`) stay
`string` and round-trip byte-for-byte.

`ConfigManager.Web` mirrors these rules in `src/utils/ConfigTypeInference.ts`. Both are
asserted against the shared table `shared/config-type-cases.json`, so the two cannot drift
apart silently — see `tests/services/config-type-inference.test.js`.

## Development Notes

- Redis operations use pipeline for atomicity (SET + PUBLISH)
- Comprehensive test coverage with Jest
- Graceful shutdown handling
- Connection retry logic built-in
- All values stored as strings in Redis

## ConfigManager Ecosystem

ConfigManager.Api is part of a comprehensive configuration management system:

- **[ConfigManager.Provider](../ConfigManager.Provider/)** - .NET Configuration Provider for seamless integration
- **[ConfigManager.Web](../ConfigManager.Web/)** - Web UI for visual configuration management
- **ConfigManager.Api** - This REST API for configuration operations

## Next Steps

Upcoming features:
- Project discovery (`GET /projects`)
- Configuration categorization (`GET /:project/configs`)  
- Configuration history and rollback
- Enhanced project management endpoints
- Integration with ConfigManager.Web UI

## Related Documentation

- [Overall ConfigManager Documentation](../README.md)
- [ConfigManager.Provider Integration Guide](../ConfigManager.Provider/README.md)
- [Real-time Configuration Examples](../ConfigManager.Provider/README.md#end-to-end-example-real-time-weather-app)