const request = require('supertest');
const express = require('express');
const redisService = require('../../src/services/redis');
const corsMiddleware = require('../../src/middleware/cors');
const { errorHandler, notFoundHandler } = require('../../src/middleware/error');
const projectRoutes = require('../../src/routes/projects');

// Create test application
const app = express();
app.use(corsMiddleware);
app.use(express.json());
app.use('/projects', projectRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

describe('Project Discovery API Routes', () => {
  beforeEach(async () => {
    // Clear test data including projects set
    const client = redisService.getClient();
    const testKeys = await client.keys('test*');
    const projectsSet = ['config:projects'];
    
    // Clear test keys
    if (testKeys.length > 0) {
      await client.del(...testKeys);
    }
    
    // Clear projects set
    await client.del(...projectsSet);
  });

  describe('GET /projects', () => {
    test('should return empty projects list when no projects exist', async () => {
      const response = await request(app)
        .get('/projects')
        .expect(200);

      expect(response.body).toEqual({
        projects: [],
        count: 0,
        source: 'empty'
      });
    });

    test('should return projects from registry set', async () => {
      // Manually add projects to set
      await redisService.sadd('config:projects', 'newwords.api', 'happynotes.api');

      const response = await request(app)
        .get('/projects')
        .expect(200);

      expect(response.body).toEqual({
        projects: ['happynotes.api', 'newwords.api'], // sorted
        count: 2,
        source: 'registry'
      });
    });

    test('should auto-migrate projects from existing config keys', async () => {
      // Create config keys without registering projects
      await redisService.set('testtestapp1:config:nlog:level', 'Debug');
      await redisService.set('testtestapp2:config:llm:timeout', '30000');
      await redisService.set('testtestapp1:config:feature:newui', 'true');

      const response = await request(app)
        .get('/projects')
        .expect(200);

      expect(response.body.projects).toEqual(['testtestapp1', 'testtestapp2']);
      expect(response.body.count).toBe(2);
      expect(response.body.source).toBe('registry');

      // Verify projects were added to the set
      const projects = await redisService.getProjects();
      expect(projects).toEqual(['testtestapp1', 'testtestapp2']);
    });
  });

  describe('GET /projects/:project/configs', () => {
    test('should return configs grouped by category', async () => {
      const project = 'testmyapp';
      
      // Set up test data
      await redisService.set(`${project}:nlog:minlevel`, 'Debug');
      await redisService.set(`${project}:nlog:maxlevel`, 'Fatal');
      await redisService.set(`${project}:llm:timeout`, '30000');
      await redisService.set(`${project}:feature:newui`, 'true');

      const response = await request(app)
        .get(`/projects/${project}/configs`)
        .expect(200);

      expect(response.body.project).toBe(project);
      expect(response.body.groups).toEqual(['feature', 'llm', 'nlog']);
      expect(response.body.totalConfigs).toBe(4);

      // Check config structure. Setting keys are the full keyname (project-
      // stripped), per the namespace model: `${project}:nlog:minlevel` ->
      // category `nlog`, setting key `nlog:minlevel`.
      expect(response.body.configs.nlog).toBeDefined();
      expect(response.body.configs.nlog['nlog:minlevel']).toEqual({
        key: `${project}:nlog:minlevel`,
        value: 'Debug',
        type: 'loglevel',
        // Stored value is untouched; only the derived parsedValue normalises.
        parsedValue: 'debug'
      });

      expect(response.body.configs.llm['llm:timeout']).toEqual({
        key: `${project}:llm:timeout`,
        value: '30000',
        type: 'integer',
        parsedValue: 30000
      });

      expect(response.body.configs.feature['feature:newui']).toEqual({
        key: `${project}:feature:newui`,
        value: 'true',
        type: 'boolean',
        parsedValue: true
      });
    });

    test('should return empty configs for project with no configurations', async () => {
      const response = await request(app)
        .get('/projects/testnonexistent/configs')
        .expect(200);

      expect(response.body).toEqual({
        project: 'testnonexistent',
        configs: {},
        groups: [],
        totalConfigs: 0
      });
    });

    test('should validate project name format', async () => {
      // Mock logger.error to verify it was called without polluting output
      const logger = require('../../src/logger');
      const loggerSpy = jest.spyOn(logger, 'error').mockImplementation();

      await request(app)
        .get('/projects/invalid project name!/configs')
        .expect(400);

      await request(app)
        .get('/projects//configs')
        .expect(400);
        
      // Verify error was logged (but silently in tests)
      expect(loggerSpy).toHaveBeenCalled();
      
      // Restore logger.error
      loggerSpy.mockRestore();
    });

    test('should handle complex setting names with colons', async () => {
      const project = 'testcomplex';
      await redisService.set(`${project}:database:connection:string`, 'postgresql://...');
      await redisService.set(`${project}:auth:jwt:secret:key`, 'secret123');

      const response = await request(app)
        .get(`/projects/${project}/configs`)
        .expect(200);

      // Setting keys are full keynames (project-stripped).
      expect(response.body.configs.database['database:connection:string']).toBeDefined();
      expect(response.body.configs.auth['auth:jwt:secret:key']).toBeDefined();
    });
  });


  describe('Error handling', () => {
    test('should handle Redis disconnection gracefully', async () => {
      // Mock logger.error to verify it was called without polluting output
      const logger = require('../../src/logger');
      const loggerSpy = jest.spyOn(logger, 'error').mockImplementation();
      
      // Simulate Redis disconnection
      const originalConnected = redisService.isConnected;
      redisService.isConnected = false;

      await request(app)
        .get('/projects')
        .expect(503);

      // Verify error was logged (but silently in tests)
      expect(loggerSpy).toHaveBeenCalled();

      // Restore connection state
      redisService.isConnected = originalConnected;
      
      // Restore logger.error
      loggerSpy.mockRestore();
    });
  });
});