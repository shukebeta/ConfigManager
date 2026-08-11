const Redis = require('ioredis');
const logger = require('../logger');

// Escape Redis glob metacharacters so a key interpolated into a SCAN/KEYS MATCH
// pattern can only ever match that key's literal children. Applies to the
// pattern only — keys returned by Redis are already literal and must be used
// unescaped for prefix stripping, deletion and publishing.
function escapeGlob(value) {
  return String(value).replace(/[\\*?[\]]/g, '\\$&');
}

// Upper bound on the child keys reported by a naming-conflict result. The check
// only needs to know whether any child exists, so the scan stops just past this
// bound instead of walking the whole keyspace, and the error message stays a
// fixed size no matter how many children a namespace holds.
const MAX_CONFLICTING_KEYS = 10;

class RedisService {
  constructor() {
    this.client = null;
    this.isConnected = false;
  }

  async connect(redisUrl = process.env.REDIS_URL || 'redis://localhost:6379') {
    try {
      this.client = new Redis(redisUrl, {
        retryDelayOnFailover: 100,
        retryDelayOnClusterDown: 300,
        maxRetriesPerRequest: 3,
        lazyConnect: true
      });

      // Connection event listeners
      this.client.on('connect', () => {
        logger.info('Redis connected');
        this.isConnected = true;
      });

      this.client.on('error', (err) => {
        logger.error({ err }, 'Redis connection error');
        this.isConnected = false;
      });

      this.client.on('close', () => {
        logger.info('Redis connection closed');
        this.isConnected = false;
      });

      // Actively connect
      await this.client.connect();
      
      return this.client;
    } catch (error) {
      logger.error({ err: error }, 'Failed to connect to Redis');
      throw error;
    }
  }

  async disconnect() {
    if (this.client) {
      await this.client.disconnect();
      this.client = null;
      this.isConnected = false;
    }
  }

  getClient() {
    if (!this.client || !this.isConnected) {
      throw new Error('Redis client not connected');
    }
    return this.client;
  }

  // Basic operation methods
  async get(key) {
    const client = this.getClient();
    return await client.get(key);
  }

  async set(key, value) {
    const client = this.getClient();
    return await client.set(key, value);
  }

  async publish(channel, message) {
    const client = this.getClient();
    return await client.publish(channel, message);
  }

  // Test-only helper: no production caller. Production keyspace walks use
  // scanStream so they never block Redis's command thread.
  async keys(pattern) {
    const client = this.getClient();
    return await client.keys(pattern);
  }

  // Set operations
  async sadd(key, ...members) {
    const client = this.getClient();
    return await client.sadd(key, ...members);
  }

  async smembers(key) {
    const client = this.getClient();
    return await client.smembers(key);
  }

  async srem(key, member) {
    const client = this.getClient();
    return await client.srem(key, member);
  }

  // Configuration specific method: atomic SET + PUBLISH + register project
  async setConfigAndPublish(key, value) {
    const client = this.getClient();
    
    // Use pipeline to ensure atomicity
    const pipeline = client.pipeline();
    pipeline.set(key, value);
    pipeline.publish(key, value);
    
    // Auto-register project from key format: project:keyname
    const [project, ...keyParts] = key.split(':');
    let hasProjectRegistration = false;
    if (project && keyParts.length > 0) {
      pipeline.sadd('config:projects', project);
      hasProjectRegistration = true;
    }
    
    const results = await pipeline.exec();
    
    // Check if all operations succeeded
    for (const [err, result] of results) {
      if (err) {
        throw new Error(`Pipeline operation failed: ${err.message}`);
      }
    }
    
    return {
      set: results[0][1],
      published: results[1][1],
      projectRegistered: hasProjectRegistration ? results[2][1] : null
    };
  }

  async deleteConfigAndPublish(key) {
    const client = this.getClient();
    
    // Use pipeline to ensure atomicity
    const pipeline = client.pipeline();
    pipeline.del(key);
    pipeline.publish(key, '__DELETED__'); // Special value to indicate deletion
    
    const results = await pipeline.exec();
    
    // Check if all operations succeeded
    for (const [err, result] of results) {
      if (err) {
        throw new Error(`Pipeline operation failed: ${err.message}`);
      }
    }
    
    return {
      deleted: results[0][1], // del returns number of keys deleted
      published: results[1][1] // publish returns number of clients that received the message
    };
  }

  // Legacy method for backward compatibility
  async setAndPublish(key, value) {
    return await this.setConfigAndPublish(key, value);
  }

  // Project discovery methods
  async getProjects() {
    const client = this.getClient();
    const projects = await client.smembers('config:projects');
    return projects.sort();
  }

  async getProjectConfigs(project) {
    const client = this.getClient();
    const pattern = `${escapeGlob(project)}:*`;
    const keys = [];
    
    // Use SCAN instead of KEYS to avoid blocking Redis
    const stream = client.scanStream({ 
      match: pattern, 
      count: 100 // Process 100 keys per iteration
    });
    
    for await (const keysChunk of stream) {
      keys.push(...keysChunk);
    }
    
    if (keys.length === 0) {
      return {};
    }
    
    // Use pipeline for batch GET operations to improve performance
    const pipeline = client.pipeline();
    keys.forEach(key => pipeline.get(key));
    const results = await pipeline.exec();
    
    // Group by category
    const configs = {};
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const [error, value] = results[i];
      
      if (error) {
        logger.error({ err: error, key }, 'Error getting value for key');
        continue;
      }
      
      // New format: project:keyname (where keyname can be multi-level)
      const [, ...keyParts] = key.split(':');
      const keyname = keyParts.join(':');
      
      // Extract category from keyname (first part)
      const category = keyParts[0] || 'general';
      const setting = keyname; // Keep the full keyname as the setting identifier
      
      if (!configs[category]) {
        configs[category] = {};
      }
      
      // Infer type and parse value
      const type = this._inferConfigType(value);
      const parsedValue = this._parseValue(value, type);
      
      configs[category][setting] = {
        key: key,
        value: value,
        type: type,
        parsedValue: parsedValue
      };
    }
    
    return configs;
  }

  // Migration method: populate projects set from existing keys
  async migrateExistingProjects() {
    const client = this.getClient();
    const projects = new Set();
    
    // Use SCAN instead of KEYS to avoid blocking Redis
    const stream = client.scanStream({ 
      match: '*:*', // Match project:keyname pattern
      count: 100 // Process 100 keys per iteration
    });
    
    for await (const keys of stream) {
      for (const key of keys) {
        // Skip system keys like config:projects
        if (key.startsWith('config:')) continue;
        
        const [project, ...keyParts] = key.split(':');
        // Only include keys that have at least one keyname part
        if (project && keyParts.length > 0) {
          projects.add(project);
        }
      }
    }
    
    // Add all discovered projects to the set
    const projectArray = Array.from(projects);
    if (projectArray.length > 0) {
      await client.sadd('config:projects', ...projectArray);
    }
    
    return {
      migrated: projectArray.length,
      projects: projectArray.sort()
    };
  }

  // Helper method to infer configuration value type
  _inferConfigType(value) {
    if (value === null || value === undefined) {
      return 'null';
    }
    
    // Convert to string if not already
    const strValue = String(value);
    
    // Check for log levels first (before JSON parsing)
    if (/^(debug|info|warn|error|fatal)$/i.test(strValue)) {
      return 'loglevel';
    }
    
    // Check for simple patterns before JSON
    if (/^\d+$/.test(strValue)) return 'integer';
    if (/^\d+\.\d+$/.test(strValue)) return 'float';
    if (/^(true|false)$/i.test(strValue)) return 'boolean';
    
    // Try to parse as JSON for complex types
    try {
      const parsed = JSON.parse(strValue);
      if (Array.isArray(parsed)) return 'array';
      if (typeof parsed === 'object' && parsed !== null) return 'object';
      // Note: JSON.parse can also parse numbers and booleans, but we handle those above
    } catch (e) {
      // Not JSON, continue
    }
    
    return 'string';
  }

  // Helper method to parse configuration value based on its type
  _parseValue(value, type) {
    if (value === null || value === undefined) {
      return null;
    }
    
    const strValue = String(value);
    
    switch (type) {
      case 'integer':
        return parseInt(strValue, 10);
      case 'float':
        return parseFloat(strValue);
      case 'boolean':
        return /^true$/i.test(strValue);
      case 'array':
      case 'object':
        try {
          return JSON.parse(strValue);
        } catch (e) {
          return strValue; // Fallback to string if parsing fails
        }
      case 'loglevel':
      case 'string':
      case 'null':
      default:
        return strValue;
    }
  }

  get MAX_CONFLICTING_KEYS() {
    return MAX_CONFLICTING_KEYS;
  }

  // Naming conflict detection for configuration keys
  async detectNamingConflicts(key) {
    const client = this.getClient();
    
    // Parse key structure
    const keyParts = key.split(':');
    
    if (keyParts.length < 2) {
      // Single part key, no conflicts possible
      return { conflict: false };
    }
    
    // Check for parent key conflicts (Scenario A: parent exists, trying to add child)
    for (let i = keyParts.length - 1; i > 1; i--) {
      const parentKey = keyParts.slice(0, i).join(':');
      const exists = await client.exists(parentKey);
      
      if (exists) {
        return {
          conflict: true,
          type: 'parent_exists',
          conflictingKey: parentKey,
          message: `Key '${key}' conflicts with existing parent key '${parentKey}'`,
          suggestion: 'Consider using a different naming structure or confirm to continue'
        };
      }
    }
    
    // Check for child key conflicts (Scenario B: children exist, trying to add parent)
    const pattern = `${escapeGlob(key)}:*`;
    const matches = new Set(); // SCAN can return the same key in several chunks

    // Use SCAN instead of KEYS to avoid blocking Redis. Collect one key past the
    // bound so truncation is known exactly, then stop the walk early.
    const stream = client.scanStream({
      match: pattern,
      count: 100
    });

    for await (const keysChunk of stream) {
      for (const childKey of keysChunk) {
        matches.add(childKey);
      }
      if (matches.size > MAX_CONFLICTING_KEYS) break;
    }

    if (matches.size > 0) {
      const truncated = matches.size > MAX_CONFLICTING_KEYS;
      const childKeys = [...matches].slice(0, MAX_CONFLICTING_KEYS);
      const shown = childKeys.join(', ');

      return {
        conflict: true,
        type: 'children_exist',
        conflictingKeys: childKeys,
        message: truncated
          ? `Key '${key}' conflicts with existing child keys: ${shown} (first ${MAX_CONFLICTING_KEYS} shown)`
          : `Key '${key}' conflicts with existing child keys: ${shown}`,
        suggestion: 'Consider using a different naming structure or confirm to continue'
      };
    }
    
    return { conflict: false };
  }

  // Check if a key already exists (for duplicate prevention)
  async checkKeyExists(key) {
    const client = this.getClient();
    const exists = await client.exists(key);
    const keyExists = exists === 1;
    
    return {
      exists: keyExists,
      message: keyExists ? `Configuration key '${key}' already exists` : null,
      suggestion: keyExists ? 'Use PUT to update existing configuration instead of POST' : null
    };
  }

  // Delete all child keys under a namespace (group deletion)
  async deleteNamespaceChildren(namespaceKey) {
    const client = this.getClient();
    
    // Find all child keys under this namespace
    const pattern = `${escapeGlob(namespaceKey)}:*`;
    const childKeys = [];
    
    // Use SCAN instead of KEYS to avoid blocking Redis
    const stream = client.scanStream({ 
      match: pattern, 
      count: 100
    });
    
    for await (const keysChunk of stream) {
      childKeys.push(...keysChunk);
    }
    
    if (childKeys.length === 0) {
      // Check if parent key exists (for consistency with non-empty case)
      const parentExists = await client.exists(namespaceKey);
      
      return {
        deleted: 0,
        published: 0,
        childKeys: [],
        preservedParent: parentExists === 1
      };
    }
    
    // Check if parent key exists (should be preserved)
    const parentExists = await client.exists(namespaceKey);
    
    // Use pipeline for atomic deletion + publishing
    const pipeline = client.pipeline();
    
    // Delete all child keys and publish deletion events
    childKeys.forEach(key => {
      pipeline.del(key);
      pipeline.publish(key, '__DELETED__');
    });
    
    const results = await pipeline.exec();
    
    // Check if all operations succeeded
    let deletedCount = 0;
    let publishedCount = 0;
    
    for (let i = 0; i < results.length; i += 2) {
      const [delError, delResult] = results[i];
      const [pubError, pubResult] = results[i + 1];
      
      if (delError) {
        throw new Error(`Delete operation failed: ${delError.message}`);
      }
      if (pubError) {
        throw new Error(`Publish operation failed: ${pubError.message}`);
      }
      
      deletedCount += delResult;
      publishedCount += pubResult;
    }
    
    return {
      deleted: deletedCount,
      published: publishedCount,
      childKeys: childKeys,
      preservedParent: parentExists === 1
    };
  }
}

// Singleton pattern
const redisService = new RedisService();

module.exports = redisService;