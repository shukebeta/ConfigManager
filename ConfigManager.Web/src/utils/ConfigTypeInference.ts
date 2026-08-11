import type { ConfigItem } from '@/types/api'

export type ConfigType = ConfigItem['type']

// Value-type inference contract, mirrored in
// ConfigManager.Api/src/services/redis.js and locked to it by the shared case
// table in shared/config-type-cases.json. Numbers follow the JSON number
// grammar, so a leading `-` and exponent notation are accepted while zero-padded
// forms (`007`) stay strings and round-trip intact.
const LOGLEVEL_PATTERN = /^(trace|debug|info|warn|error|fatal)$/i
const INTEGER_PATTERN = /^-?(0|[1-9]\d*)$/
const FLOAT_PATTERN = /^-?(0|[1-9]\d*)(\.\d+([eE][+-]?\d+)?|[eE][+-]?\d+)$/

/**
 * Infer configuration value type based on its string value
 * Mirrors the backend _inferConfigType logic for consistency
 */
export function inferConfigType(value: string | null | undefined): ConfigType {
  if (value === null || value === undefined) {
    return 'null'
  }

  // Convert to string if not already
  const strValue = String(value)

  // Check for log levels first (before JSON parsing)
  if (LOGLEVEL_PATTERN.test(strValue)) {
    return 'loglevel'
  }

  // Check for simple patterns before JSON
  if (INTEGER_PATTERN.test(strValue)) return 'integer'
  if (FLOAT_PATTERN.test(strValue)) return 'float'
  if (/^(true|false)$/i.test(strValue)) return 'boolean'

  // Try to parse as JSON for complex types
  try {
    const parsed = JSON.parse(strValue)
    if (Array.isArray(parsed)) return 'array'
    if (typeof parsed === 'object' && parsed !== null) return 'object'
    // Note: JSON.parse can also parse numbers and booleans, but we handle those above
  } catch (e) {
    // Not JSON, continue
  }

  return 'string'
}

/**
 * Parse configuration value based on its inferred type
 * Mirrors the backend _parseValue logic for consistency
 */
export function parseConfigValue(value: string | null | undefined, type: ConfigType): any {
  if (value === null || value === undefined) {
    return null
  }

  const strValue = String(value)

  switch (type) {
    case 'integer':
      return parseInt(strValue, 10)
    case 'float':
      return parseFloat(strValue)
    case 'boolean':
      return strValue.toLowerCase() === 'true'
    case 'loglevel':
      return strValue.toLowerCase()
    case 'array':
    case 'object':
      try {
        return JSON.parse(strValue)
      } catch (e) {
        return strValue // fallback to string if JSON parsing fails
      }
    case 'null':
      return null
    case 'string':
    default:
      return strValue
  }
}

/**
 * Create a complete ConfigItem with inferred type and parsed value
 */
export function createConfigItem(key: string, value: string): Omit<ConfigItem, 'key'> {
  const type = inferConfigType(value)
  const parsedValue = parseConfigValue(value, type)
  
  return {
    value,
    type,
    parsedValue
  }
}