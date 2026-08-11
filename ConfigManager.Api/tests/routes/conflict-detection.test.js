const request = require('supertest');
const express = require('express');
const redisService = require('../../src/services/redis');
const corsMiddleware = require('../../src/middleware/cors');
const { errorHandler, notFoundHandler } = require('../../src/middleware/error');
const configRoutes = require('../../src/routes/config');

// Create test application
const app = express();
app.use(corsMiddleware);
app.use(express.json());
app.use('/redis', configRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

describe('Conflict Detection Tests', () => {
  // Test data is automatically cleaned by setup.js

  describe('Duplicate Key Detection', () => {
    test('should prevent duplicate key creation via POST', async () => {
      const key = 'test:config1';
      const value1 = 'first-value';
      const value2 = 'second-value';

      // 1. Create initial configuration
      await request(app)
        .post(`/redis/${key}`)
        .send({ value: value1 })
        .expect(200);

      // 2. Try to create duplicate key - should fail
      const duplicateResponse = await request(app)
        .post(`/redis/${key}`)
        .send({ value: value2 })
        .expect(400);
      expect(duplicateResponse.body.error).toBe('key_already_exists');
      expect(duplicateResponse.body.message).toContain('already exists');

      // 3. Verify original value unchanged
      const getResponse = await request(app)
        .get(`/redis/${key}`)
        .expect(200);

      expect(getResponse.body.value).toBe(value1);
    });

    test('should allow duplicate key creation with forceAdd=true', async () => {
      const key = 'test:config1';
      const value1 = 'first-value';
      const value2 = 'second-value';

      // 1. Create initial configuration
      await request(app)
        .post(`/redis/${key}`)
        .send({ value: value1 })
        .expect(200);

      // 2. Create duplicate with forceAdd=true - should succeed
      const forceResponse = await request(app)
        .post(`/redis/${key}?forceAdd=true`)
        .send({ value: value2 })
        .expect(200);

      expect(forceResponse.body.success).toBe(true);
      expect(forceResponse.body.value).toBe(value2);
      expect(forceResponse.body.warning.type).toBe('conflicts_bypassed');

      // 3. Verify value was updated
      const getResponse = await request(app)
        .get(`/redis/${key}`)
        .expect(200);

      expect(getResponse.body.value).toBe(value2);
    });

    test('should allow updates via PUT without conflict detection', async () => {
      const key = 'test:config1';
      const value1 = 'first-value';
      const value2 = 'updated-value';

      // 1. Create initial configuration
      await request(app)
        .post(`/redis/${key}`)
        .send({ value: value1 })
        .expect(200);

      // 2. Update via PUT - should succeed
      await request(app)
        .put(`/redis/${key}`)
        .send({ value: value2 })
        .expect(200);

      // 3. Verify value was updated
      const getResponse = await request(app)
        .get(`/redis/${key}`)
        .expect(200);

      expect(getResponse.body.value).toBe(value2);
    });
  });

  describe('Parent-Child Conflict Detection', () => {
    test('should detect parent exists conflict when adding child', async () => {
      const parentKey = 'test:config1';
      const childKey = 'test:config1:key1';

      // 1. Create parent configuration
      await request(app)
        .post(`/redis/${parentKey}`)
        .send({ value: 'parent-value' })
        .expect(200);

      // 2. Try to create child - should fail with naming conflict
      const childResponse = await request(app)
        .post(`/redis/${childKey}`)
        .send({ value: 'child-value' })
        .expect(400);

      expect(childResponse.body.error).toBe('naming_conflict');
      expect(childResponse.body.conflictType).toBe('parent_exists');
      expect(childResponse.body.conflictingKey).toBe(parentKey);
      expect(childResponse.body.message).toContain('conflicts with existing parent key');
    });

    test('should detect children exist conflict when adding parent', async () => {
      const parentKey = 'test:parent';
      const childKey1 = 'test:parent:child1';
      const childKey2 = 'test:parent:child2';

      // 1. Create child configurations
      await request(app)
        .post(`/redis/${childKey1}`)
        .send({ value: 'child1-value' })
        .expect(200);

      await request(app)
        .post(`/redis/${childKey2}`)
        .send({ value: 'child2-value' })
        .expect(200);

      // 2. Try to create parent - should fail with naming conflict
      const parentResponse = await request(app)
        .post(`/redis/${parentKey}`)
        .send({ value: 'parent-value' })
        .expect(400);

      expect(parentResponse.body.error).toBe('naming_conflict');
      expect(parentResponse.body.conflictType).toBe('children_exist');
      expect(parentResponse.body.conflictingKeys).toContain(childKey1);
      expect(parentResponse.body.conflictingKeys).toContain(childKey2);
      expect(parentResponse.body.message).toContain('conflicts with existing child keys');
    });

    test('should allow parent-child conflicts with forceAdd=true', async () => {
      const parentKey = 'test:config2';
      const childKey = 'test:config2:subkey';

      // 1. Create parent configuration
      await request(app)
        .post(`/redis/${parentKey}`)
        .send({ value: 'parent-value' })
        .expect(200);

      // 2. Create child with forceAdd=true - should succeed
      const childResponse = await request(app)
        .post(`/redis/${childKey}?forceAdd=true`)
        .send({ value: 'child-value' })
        .expect(200);

      expect(childResponse.body.success).toBe(true);
      expect(childResponse.body.warning.type).toBe('conflicts_bypassed');

      // 3. Verify both keys exist
      const parentCheck = await request(app)
        .get(`/redis/${parentKey}`)
        .expect(200);

      const childCheck = await request(app)
        .get(`/redis/${childKey}`)
        .expect(200);

      expect(parentCheck.body.value).toBe('parent-value');
      expect(childCheck.body.value).toBe('child-value');
    });
  });

  describe('Complex Naming Scenarios', () => {
    test('should handle deep nesting conflicts', async () => {
      const level1 = 'test:app:config';
      const level2 = 'test:app:config:database';
      const level3 = 'test:app:config:database:timeout';

      // 1. Create level 1
      await request(app)
        .post(`/redis/${level1}`)
        .send({ value: 'level1-value' })
        .expect(200);

      // 2. Try level 3 (skipping level 2) - should detect level 1 conflict
      const level3Response = await request(app)
        .post(`/redis/${level3}`)
        .send({ value: 'level3-value' })
        .expect(400);

      expect(level3Response.body.error).toBe('naming_conflict');
      expect(level3Response.body.conflictType).toBe('parent_exists');
      expect(level3Response.body.conflictingKey).toBe(level1);
    });

    test('should allow non-conflicting sibling configurations', async () => {
      const config1 = 'test:app:feature1';
      const config2 = 'test:app:feature2';
      const config3 = 'test:app:feature1:enabled';

      // 1. Create sibling configurations - should succeed
      await request(app)
        .post(`/redis/${config1}`)
        .send({ value: 'feature1-value' })
        .expect(200);

      await request(app)
        .post(`/redis/${config2}`)
        .send({ value: 'feature2-value' })
        .expect(200);

      // 2. Try to create child of config1 - should fail due to parent exists
      const childResponse = await request(app)
        .post(`/redis/${config3}`)
        .send({ value: 'enabled-value' })
        .expect(400);

      expect(childResponse.body.error).toBe('naming_conflict');
      expect(childResponse.body.conflictType).toBe('parent_exists');
      expect(childResponse.body.conflictingKey).toBe(config1);
    });
  });

  describe('Service Layer Tests', () => {
    test('redis service detectNamingConflicts should work correctly', async () => {
      // Set up test data using business methods
      await redisService.setConfigAndPublish('test:parent', 'parent-value');
      await redisService.setConfigAndPublish('test:child:key1', 'child1-value');
      await redisService.setConfigAndPublish('test:child:key2', 'child2-value');

      // Test parent exists scenario
      const parentConflict = await redisService.detectNamingConflicts('test:parent:newkey');
      expect(parentConflict.conflict).toBe(true);
      expect(parentConflict.type).toBe('parent_exists');
      expect(parentConflict.conflictingKey).toBe('test:parent');

      // Test children exist scenario
      const childrenConflict = await redisService.detectNamingConflicts('test:child');
      expect(childrenConflict.conflict).toBe(true);
      expect(childrenConflict.type).toBe('children_exist');
      expect(childrenConflict.conflictingKeys).toContain('test:child:key1');
      expect(childrenConflict.conflictingKeys).toContain('test:child:key2');

      // Test no conflict scenario
      const noConflict = await redisService.detectNamingConflicts('test:newkey');
      expect(noConflict.conflict).toBe(false);

      // Test data automatically cleaned by setup.js
    });

    test('children_exist result is bounded when a namespace has many children', async () => {
      const max = redisService.MAX_CONFLICTING_KEYS;
      const namespace = 'test:crowded';
      const childCount = max + 5;

      for (let i = 0; i < childCount; i++) {
        await redisService.setConfigAndPublish(`${namespace}:key${i}`, `value-${i}`);
      }

      const conflict = await redisService.detectNamingConflicts(namespace);
      expect(conflict.conflict).toBe(true);
      expect(conflict.type).toBe('children_exist');
      expect(conflict.conflictingKeys).toHaveLength(max);
      conflict.conflictingKeys.forEach(key => {
        expect(key.startsWith(`${namespace}:`)).toBe(true);
      });
      expect(new Set(conflict.conflictingKeys).size).toBe(max);
      expect(conflict.message).toContain(`(first ${max} shown)`);
      // Message lists at most `max` keys, so it cannot grow with the namespace
      expect(conflict.message.split(', ')).toHaveLength(max);

      // Same bound is what the route surfaces to the client
      const response = await request(app)
        .post(`/redis/${namespace}`)
        .send({ value: 'parent-value' })
        .expect(400);

      expect(response.body.error).toBe('naming_conflict');
      expect(response.body.conflictType).toBe('children_exist');
      expect(response.body.conflictingKeys).toHaveLength(max);
    });

    test('redis service checkKeyExists should work correctly', async () => {
      const testKey = 'test:exists-check';
      
      // Test non-existent key
      const notExists = await redisService.checkKeyExists(testKey);
      expect(notExists.exists).toBe(false);

      // Create key using business method
      await redisService.setConfigAndPublish(testKey, 'test-value');

      // Test existing key
      const exists = await redisService.checkKeyExists(testKey);
      expect(exists.exists).toBe(true);
      expect(exists.message).toContain('already exists');

      // Test data automatically cleaned by setup.js
    });
  });
});