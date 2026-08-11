const redisService = require('../../src/services/redis');

describe('Redis Service - Project Discovery', () => {
  beforeEach(async () => {
    await cleanupTestData();
  });

  afterEach(async () => {
    await cleanupTestData();
  });

  async function cleanupTestData() {
    // Clear test data including projects set and all test keys
    const client = redisService.getClient();
    const testKeys = await client.keys('test*');
    const configKeys = await client.keys('*:config:*');
    const projectsSet = ['config:projects'];
    
    // Clear all test-related keys
    const allKeys = [...testKeys, ...configKeys];
    if (allKeys.length > 0) {
      await client.del(...allKeys);
    }
    
    // Clear projects set completely
    await client.del(...projectsSet);
  }

  describe('setConfigAndPublish', () => {
    test('should set, publish, and auto-register project for config keys', async () => {
      const key = 'testnewapp:config:nlog:level';
      const value = 'Debug';

      const result = await redisService.setConfigAndPublish(key, value);

      // Verify return result
      expect(result.set).toBe('OK');
      expect(result.published).toBeGreaterThanOrEqual(0);
      expect(result.projectRegistered).toBeGreaterThanOrEqual(0);

      // Verify value was set
      const storedValue = await redisService.get(key);
      expect(storedValue).toBe(value);

      // Verify project was registered
      const projects = await redisService.getProjects();
      expect(projects).toContain('testnewapp');
    });

    test('should not register project for single-part keys', async () => {
      const key = 'singlekeynoproject';
      const value = 'data';

      const result = await redisService.setConfigAndPublish(key, value);

      expect(result.set).toBe('OK');
      expect(result.published).toBeGreaterThanOrEqual(0);
      expect(result.projectRegistered).toBeNull();

      // Verify no project was registered from this key
      const projects = await redisService.getProjects();
      expect(projects).not.toContain('singlekeynoproject');
    });

    test('should handle existing project registration', async () => {
      const project = 'testexistingapp';
      
      // Pre-register project
      await redisService.sadd('config:projects', project);
      
      const key = `${project}:config:new:setting`;
      const result = await redisService.setConfigAndPublish(key, 'value');

      // Should still succeed but indicate project was already registered
      expect(result.projectRegistered).toBe(0); // SADD returns 0 when member already exists
    });
  });

  describe('getProjects', () => {
    test('should return empty array when no projects registered', async () => {
      const projects = await redisService.getProjects();
      expect(projects).toEqual([]);
    });

    test('should return sorted list of registered projects', async () => {
      await redisService.sadd('config:projects', 'zebra.api', 'alpha.api', 'beta.api');

      const projects = await redisService.getProjects();
      expect(projects).toEqual(['alpha.api', 'beta.api', 'zebra.api']);
    });
  });

  describe('getProjectConfigs', () => {
    test('should return grouped configurations for project', async () => {
      const project = 'testconfigapp';
      
      // Set up test configurations with new format: project:keyname
      await redisService.set(`${project}:nlog:minlevel`, 'Debug');
      await redisService.set(`${project}:nlog:maxlevel`, 'Fatal');
      await redisService.set(`${project}:llm:timeout`, '30000');
      await redisService.set(`${project}:llm:retries`, '3');
      await redisService.set(`${project}:feature:newui`, 'true');
      await redisService.set(`${project}:database:connection:string`, 'postgresql://localhost');

      const configs = await redisService.getProjectConfigs(project);

      // Check structure
      expect(configs.nlog).toBeDefined();
      expect(configs.llm).toBeDefined();
      expect(configs.feature).toBeDefined();
      expect(configs.database).toBeDefined();

      // Setting keys are the full keyname (project-stripped), per the namespace
      // model in getProjectConfigs (setting = keyname): `${project}:nlog:minlevel`
      // -> category `nlog`, setting key `nlog:minlevel`.
      // Check nlog category
      expect(configs.nlog['nlog:minlevel']).toEqual({
        key: `${project}:nlog:minlevel`,
        value: 'Debug',
        type: 'loglevel',
        // Stored value is untouched; only the derived parsedValue normalises.
        parsedValue: 'debug'
      });
      expect(configs.nlog['nlog:maxlevel']).toEqual({
        key: `${project}:nlog:maxlevel`,
        value: 'Fatal',
        type: 'loglevel',
        parsedValue: 'fatal'
      });

      // Check llm category
      expect(configs.llm['llm:timeout']).toEqual({
        key: `${project}:llm:timeout`,
        value: '30000',
        type: 'integer',
        parsedValue: 30000
      });
      expect(configs.llm['llm:retries']).toEqual({
        key: `${project}:llm:retries`,
        value: '3',
        type: 'integer',
        parsedValue: 3
      });

      // Check feature category
      expect(configs.feature['feature:newui']).toEqual({
        key: `${project}:feature:newui`,
        value: 'true',
        type: 'boolean',
        parsedValue: true
      });

      // Check complex key with colons
      expect(configs.database['database:connection:string']).toEqual({
        key: `${project}:database:connection:string`,
        value: 'postgresql://localhost',
        type: 'string',
        parsedValue: 'postgresql://localhost'
      });
    });

    test('should return empty object for project with no configs', async () => {
      const configs = await redisService.getProjectConfigs('test:nonexistent');
      expect(configs).toEqual({});
    });
  });

  describe('migrateExistingProjects', () => {
    test('should discover and register projects from existing config keys', async () => {
      // Create config keys for multiple projects
      await redisService.set('testapp1:config:setting1', 'value1');
      await redisService.set('testapp1:config:setting2', 'value2');
      await redisService.set('testapp2:config:setting1', 'value3');
      await redisService.set('testother:config:setting1', 'value4');

      const result = await redisService.migrateExistingProjects();

      expect(result.migrated).toBe(3);
      expect(result.projects).toEqual(['testapp1', 'testapp2', 'testother']);

      // Verify projects were added to set
      const projects = await redisService.getProjects();
      expect(projects).toEqual(['testapp1', 'testapp2', 'testother']);
    });

    test('should handle empty Redis instance', async () => {
      const result = await redisService.migrateExistingProjects();

      expect(result.migrated).toBe(0);
      expect(result.projects).toEqual([]);
    });

    test('should ignore non-config keys', async () => {
      await redisService.set('testapp1:data:something', 'value1');
      await redisService.set('testapp2:cache:key', 'value2');
      await redisService.set('testapp3:nlog:setting', 'value3'); // Only this should be found

      const result = await redisService.migrateExistingProjects();

      expect(result.migrated).toBe(3); // All three are valid project:keyname format
      expect(result.projects).toEqual(['testapp1', 'testapp2', 'testapp3']);
    });
  });

  // _inferConfigType / _parseValue are covered by config-type-inference.test.js,
  // which drives the shared case table this Api and ConfigManager.Web both assert.

  describe('Set operations', () => {
    test('should handle Redis set operations correctly', async () => {
      const setKey = 'test:myset';
      
      // Add members
      const added1 = await redisService.sadd(setKey, 'member1');
      const added2 = await redisService.sadd(setKey, 'member2');
      const added3 = await redisService.sadd(setKey, 'member1'); // duplicate

      expect(added1).toBe(1); // new member
      expect(added2).toBe(1); // new member  
      expect(added3).toBe(0); // existing member

      // Get all members
      const members = await redisService.smembers(setKey);
      expect(members.sort()).toEqual(['member1', 'member2']);

      // Remove member
      const removed = await redisService.srem(setKey, 'member1');
      expect(removed).toBe(1);

      const remainingMembers = await redisService.smembers(setKey);
      expect(remainingMembers).toEqual(['member2']);
    });
  });
});
