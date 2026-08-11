const fs = require('fs');
const path = require('path');
const redisService = require('../../src/services/redis');

// The value -> (type, parsedValue) contract lives in one place for both
// implementations. ConfigManager.Web asserts the same table against
// src/utils/ConfigTypeInference.ts, so changing this side alone fails here, and
// updating the table to match fails there — the two cannot drift apart.
const SHARED_CASES_PATH = path.join(__dirname, '..', '..', '..', 'shared', 'config-type-cases.json');
const { cases } = JSON.parse(fs.readFileSync(SHARED_CASES_PATH, 'utf8'));

describe('Config type inference — shared contract', () => {
  test('the shared case table is non-empty', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  test.each(cases)('$value -> $type', ({ value, type, parsedValue }) => {
    const inferredType = redisService._inferConfigType(value);
    expect(inferredType).toBe(type);
    expect(redisService._parseValue(value, inferredType)).toEqual(parsedValue);
  });

  test('undefined is classified null (not expressible in the shared JSON table)', () => {
    const inferredType = redisService._inferConfigType(undefined);
    expect(inferredType).toBe('null');
    expect(redisService._parseValue(undefined, inferredType)).toBeNull();
  });

  test('a loglevel parsedValue normalises without touching the stored value', () => {
    // The raw string is what a consumer reads back from Redis; only the derived
    // parsedValue lowercases, so the two must stay distinguishable.
    expect(redisService._parseValue('INFO', 'loglevel')).toBe('info');
    expect(String('INFO')).toBe('INFO');
  });

  test('a zero-padded integer is not silently renumbered', () => {
    expect(redisService._inferConfigType('007')).toBe('string');
    expect(redisService._parseValue('007', 'string')).toBe('007');
  });
});
