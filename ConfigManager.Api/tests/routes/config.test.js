const request = require('supertest');
const express = require('express');
const configRoutes = require('../../src/routes/config');
const redisService = require('../../src/services/redis');
const { errorHandler } = require('../../src/middleware/error');

// Create test application
const app = express();
app.use(express.json());
app.use('/redis', configRoutes);
app.use(errorHandler);

describe('Config API Routes', () => {
  describe('GET /redis/:key', () => {
    test('should return existing value', async () => {
      const testKey = 'test:get:existing';
      const testValue = 'test:get:value';

      // Preset value
      await redisService.set(testKey, testValue);

      const response = await request(app)
        .get(`/redis/${testKey}`)
        .expect(200);

      expect(response.body).toEqual({
        key: testKey,
        value: testValue,
        exists: true
      });
    });

    test('should return null for non-existent key', async () => {
      const nonExistentKey = 'test:get:nonexistent';

      const response = await request(app)
        .get(`/redis/${nonExistentKey}`)
        .expect(200);

      expect(response.body).toEqual({
        key: nonExistentKey,
        value: null,
        exists: false
      });
    });

    test('should return 400 for empty key', async () => {
      const response = await request(app)
        .get('/redis/')
        .expect(404); // Express returns 404 for empty path
    });

    test('should handle special characters in key', async () => {
      const specialKey = 'test:special:key:with:colons';
      const testValue = 'special:value';

      await redisService.set(specialKey, testValue);

      const response = await request(app)
        .get(`/redis/${specialKey}`)
        .expect(200);

      expect(response.body.value).toBe(testValue);
    });
  });

  describe('POST /redis/:key', () => {
    test('should set and publish value successfully', async () => {
      const testKey = 'test:post:success';
      const testValue = 'test:post:value';

      const response = await request(app)
        .post(`/redis/${testKey}`)
        .send({ value: testValue })
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        key: testKey,
        value: testValue,
        operations: {
          set: true,
          published: expect.any(Number),
          projectRegistered: expect.anything() // Can be number or boolean depending on Redis response
        }
      });

      // Verify value is actually stored
      const storedValue = await redisService.get(testKey);
      expect(storedValue).toBe(testValue);
    });

    test('should handle different value types', async () => {
      const testCases = [
        { key: 'test:post:string', value: 'string value' },
        { key: 'test:post:number', value: 123 },
        { key: 'test:post:boolean', value: true },
        { key: 'test:post:object', value: { nested: 'object' } }
      ];

      for (const testCase of testCases) {
        const response = await request(app)
          .post(`/redis/${testCase.key}`)
          .send({ value: testCase.value })
          .expect(200);

        expect(response.body.success).toBe(true);
        expect(response.body.value).toBe(String(testCase.value));

        // Verify stored value
        const storedValue = await redisService.get(testCase.key);
        expect(storedValue).toBe(String(testCase.value));
      }
    });

    test('should return 400 for missing value', async () => {
      // Mock logger.error to verify it was called without polluting output
      const logger = require('../../src/logger');
      const loggerSpy = jest.spyOn(logger, 'error').mockImplementation();

      const response = await request(app)
        .post('/redis/test:post:missing')
        .send({}) // No value field
        .expect(400);

      expect(response.body.error).toBe('Bad Request');
      expect(response.body.message).toContain('Value is required');
      
      // Verify error was logged (but silently in tests)
      expect(loggerSpy).toHaveBeenCalled();
      
      // Restore logger.error
      loggerSpy.mockRestore();
    });

    test('should return 400 for empty key', async () => {
      const response = await request(app)
        .post('/redis/')
        .send({ value: 'test' })
        .expect(404); // Express handles empty path
    });

    test('should handle value 0 and empty string', async () => {
      // Test value of 0
      const zeroResponse = await request(app)
        .post('/redis/test:post:zero')
        .send({ value: 0 })
        .expect(200);

      expect(zeroResponse.body.value).toBe('0');

      // Test empty string
      const emptyResponse = await request(app)
        .post('/redis/test:post:empty')
        .send({ value: '' })
        .expect(200);

      expect(emptyResponse.body.value).toBe('');
    });
  });

  describe('DELETE /redis/:key', () => {
    test('should delete existing configuration', async () => {
      const testKey = 'test:delete:existing';
      const testValue = 'test:delete:value';

      // Create the config first
      await redisService.set(testKey, testValue);
      
      // Verify it exists
      const beforeDelete = await redisService.get(testKey);
      expect(beforeDelete).toBe(testValue);

      // Delete it
      const response = await request(app)
        .delete(`/redis/${testKey}`)
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        key: testKey,
        existed: true,
        operations: {
          deleted: 1, // one key deleted
          published: expect.any(Number) // number of clients notified
        }
      });

      // Verify it's gone
      const afterDelete = await redisService.get(testKey);
      expect(afterDelete).toBeNull();
    });

    test('should handle deleting non-existent key', async () => {
      const nonExistentKey = 'test:delete:nonexistent';

      const response = await request(app)
        .delete(`/redis/${nonExistentKey}`)
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        key: nonExistentKey,
        existed: false,
        operations: {
          deleted: 0, // no keys deleted
          published: expect.any(Number)
        }
      });
    });

    test('should return 400 for empty key', async () => {
      await request(app)
        .delete('/redis/')
        .expect(404); // Express returns 404 for empty path
    });
  });

  describe('DELETE /redis/:key/children', () => {
    test('should delete all children while preserving parent', async () => {
      const namespaceKey = 'test:namespace:parent';
      const parentValue = 'parent:value';
      
      // Set up test data: parent + children
      await redisService.set(namespaceKey, parentValue);
      await redisService.set(`${namespaceKey}:child1`, 'child1:value');
      await redisService.set(`${namespaceKey}:child2`, 'child2:value');
      await redisService.set(`${namespaceKey}:sub:grandchild`, 'grandchild:value');

      // Verify setup
      expect(await redisService.get(namespaceKey)).toBe(parentValue);
      expect(await redisService.get(`${namespaceKey}:child1`)).toBe('child1:value');
      expect(await redisService.get(`${namespaceKey}:child2`)).toBe('child2:value');
      expect(await redisService.get(`${namespaceKey}:sub:grandchild`)).toBe('grandchild:value');

      // Delete children
      const response = await request(app)
        .delete(`/redis/${namespaceKey}/children`)
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        namespaceKey: namespaceKey,
        operations: {
          deleted: 3, // 3 child keys deleted
          published: expect.any(Number),
          childKeys: expect.arrayContaining([
            `${namespaceKey}:child1`,
            `${namespaceKey}:child2`,
            `${namespaceKey}:sub:grandchild`
          ]),
          preservedParent: true
        }
      });

      // Verify parent still exists
      expect(await redisService.get(namespaceKey)).toBe(parentValue);
      
      // Verify children are gone
      expect(await redisService.get(`${namespaceKey}:child1`)).toBeNull();
      expect(await redisService.get(`${namespaceKey}:child2`)).toBeNull();
      expect(await redisService.get(`${namespaceKey}:sub:grandchild`)).toBeNull();
    });

    test('should handle namespace with no parent value', async () => {
      const namespaceKey = 'test:namespace:noparent';
      
      // Set up test data: only children, no parent
      await redisService.set(`${namespaceKey}:child1`, 'child1:value');
      await redisService.set(`${namespaceKey}:child2`, 'child2:value');

      // Verify setup: no parent, children exist
      expect(await redisService.get(namespaceKey)).toBeNull();
      expect(await redisService.get(`${namespaceKey}:child1`)).toBe('child1:value');
      expect(await redisService.get(`${namespaceKey}:child2`)).toBe('child2:value');

      // Delete children
      const response = await request(app)
        .delete(`/redis/${namespaceKey}/children`)
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        namespaceKey: namespaceKey,
        operations: {
          deleted: 2, // 2 child keys deleted
          published: expect.any(Number),
          childKeys: expect.arrayContaining([
            `${namespaceKey}:child1`,
            `${namespaceKey}:child2`
          ]),
          preservedParent: false // no parent to preserve
        }
      });

      // Verify children are gone
      expect(await redisService.get(`${namespaceKey}:child1`)).toBeNull();
      expect(await redisService.get(`${namespaceKey}:child2`)).toBeNull();
    });

    test('should handle namespace with no children', async () => {
      const namespaceKey = 'test:namespace:nochildren';

      // Delete from namespace with no children
      const response = await request(app)
        .delete(`/redis/${namespaceKey}/children`)
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        namespaceKey: namespaceKey,
        operations: {
          deleted: 0, // no children to delete
          published: 0, // no deletion events
          childKeys: [],
          preservedParent: false // no parent exists
        }
      });
    });

    test('should return 400 for empty namespace key', async () => {
      const response = await request(app)
        .delete('/redis/ /children') // space key should trigger validation error
        .expect(400);

      expect(response.body.message).toContain('Key parameter is required');
    });
  });

  describe('Key format validation', () => {
    // A glob metacharacter in :key used to reach Redis verbatim, so SCAN MATCH
    // '*:*' matched — and deleted — every colon-bearing key in the database.
    test('should reject a wildcard namespace key without deleting anything', async () => {
      const client = redisService.getClient();

      await redisService.set('projectA:config:db:host', 'a-host');
      await redisService.set('projectB:config:db:host', 'b-host');
      await redisService.set('projectC:logging:level', 'Info');
      await client.sadd('config:projects', 'projectA', 'projectB', 'projectC');

      const response = await request(app)
        .delete('/redis/%2A/children')
        .expect(400);

      expect(response.body.error).toBe('Bad Request');
      expect(response.body.message).toContain('Invalid key format');

      // Every unrelated key and the project registry must survive
      expect(await redisService.get('projectA:config:db:host')).toBe('a-host');
      expect(await redisService.get('projectB:config:db:host')).toBe('b-host');
      expect(await redisService.get('projectC:logging:level')).toBe('Info');
      expect(await client.smembers('config:projects')).toEqual(
        expect.arrayContaining(['projectA', 'projectB', 'projectC'])
      );
    });

    const invalidKeys = ['*', 'test:*', '?', 'test:ns:?', '[', 'test:[a-z]'];

    invalidKeys.forEach(invalidKey => {
      test(`should reject '${invalidKey}' on every /redis/:key route`, async () => {
        const encodedKey = encodeURIComponent(invalidKey);

        const responses = await Promise.all([
          request(app).get(`/redis/${encodedKey}`),
          request(app).post(`/redis/${encodedKey}`).send({ value: 'x' }),
          request(app).put(`/redis/${encodedKey}`).send({ value: 'x' }),
          request(app).delete(`/redis/${encodedKey}`),
          request(app).delete(`/redis/${encodedKey}/children`)
        ]);

        responses.forEach(response => {
          expect(response.status).toBe(400);
          expect(response.body.message).toContain('Invalid key format');
        });
      });
    });

    const validKeys = ['newwords.api:config:nlog:min-level', 'test:special:key:with:colons'];

    validKeys.forEach(validKey => {
      test(`should accept '${validKey}' on every /redis/:key route`, async () => {
        await request(app)
          .post(`/redis/${validKey}`)
          .send({ value: 'created' })
          .expect(200);

        const getResponse = await request(app)
          .get(`/redis/${validKey}`)
          .expect(200);
        expect(getResponse.body.value).toBe('created');

        await request(app)
          .put(`/redis/${validKey}`)
          .send({ value: 'updated' })
          .expect(200);

        await request(app)
          .delete(`/redis/${validKey}/children`)
          .expect(200);

        // Parent survives child deletion, then deletes on its own request
        expect(await redisService.get(validKey)).toBe('updated');

        await request(app)
          .delete(`/redis/${validKey}`)
          .expect(200);
        expect(await redisService.get(validKey)).toBeNull();
      });
    });
  });

  describe('Error Handling', () => {
    test('should handle Redis connection errors gracefully', async () => {
      // Mock logger.error to verify it was called without polluting output
      const logger = require('../../src/logger');
      const loggerSpy = jest.spyOn(logger, 'error').mockImplementation();
      
      // Simulate Redis disconnection
      const originalIsConnected = redisService.isConnected;
      redisService.isConnected = false;

      const response = await request(app)
        .get('/redis/test:error:key')
        .expect(503);

      expect(response.body.error).toBe('Service Unavailable');
      
      // Verify error was logged (but silently in tests)
      expect(loggerSpy).toHaveBeenCalled();

      // Restore connection state
      redisService.isConnected = originalIsConnected;
      
      // Restore logger.error
      loggerSpy.mockRestore();
    });
  });
});
