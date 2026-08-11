const express = require('express');
const redisService = require('../services/redis');
const { isValidConfigKey } = require('../utils/keys');

const router = express.Router();

// Validate :key once for every route that takes it, so no handler can reach the
// Redis service with a key holding glob metacharacters. Kept synchronous: an
// async param callback that rejects is not caught by express 4.
router.param('key', (req, res, next, key) => {
  if (!key || key.trim() === '') {
    const error = new Error('Key parameter is required');
    error.type = 'validation';
    return next(error);
  }

  if (!isValidConfigKey(key)) {
    const error = new Error(
      'Invalid key format: only letters, digits and the characters . _ : - are allowed'
    );
    error.type = 'validation';
    return next(error);
  }

  next();
});

// GET /redis/:key - Get configuration value
router.get('/:key', async (req, res, next) => {
  try {
    const { key } = req.params;

    const value = await redisService.get(key);
    
    res.json({
      key,
      value: value || null,
      exists: value !== null
    });
  } catch (error) {
    next(error);
  }
});

// POST /redis/:key - Create new configuration value (SET + PUBLISH)
router.post('/:key', async (req, res, next) => {
  try {
    const { key } = req.params;
    const { value } = req.body;
    const forceAdd = req.query.forceAdd === 'true';

    if (value === undefined) {
      const error = new Error('Value is required in request body');
      error.type = 'validation';
      throw error;
    }

    // Validation checks (skip if forceAdd is true)
    if (!forceAdd) {
      // Check if key already exists
      const keyCheck = await redisService.checkKeyExists(key);
      if (keyCheck.exists) {
        const error = new Error(keyCheck.message);
        error.type = 'key_already_exists';
        error.suggestion = keyCheck.suggestion;
        throw error;
      }

      // Check for naming conflicts
      const conflictResult = await redisService.detectNamingConflicts(key);
      if (conflictResult.conflict) {
        const error = new Error(conflictResult.message);
        error.type = 'naming_conflict';
        error.conflictType = conflictResult.type;
        error.conflictingKey = conflictResult.conflictingKey;
        error.conflictingKeys = conflictResult.conflictingKeys;
        error.suggestion = conflictResult.suggestion;
        throw error;
      }
    }

    // Execute SET + PUBLISH + auto-register project
    const result = await redisService.setConfigAndPublish(key, String(value));
    
    const response = {
      success: true,
      key,
      value: String(value),
      operations: {
        set: result.set === 'OK',
        published: result.published, // publish returns number of clients that received the message
        projectRegistered: result.projectRegistered !== null ? result.projectRegistered >= 0 : null
      }
    };

    // Add warning if conflicts were bypassed
    if (forceAdd) {
      response.warning = {
        type: 'conflicts_bypassed',
        message: 'Configuration added with forceAdd=true, potential naming conflicts not checked'
      };
    }

    res.json(response);
  } catch (error) {
    next(error);
  }
});

// PUT /redis/:key - Update existing configuration value (SET + PUBLISH)
router.put('/:key', async (req, res, next) => {
  try {
    const { key } = req.params;
    const { value } = req.body;

    if (value === undefined) {
      const error = new Error('Value is required in request body');
      error.type = 'validation';
      throw error;
    }

    // Execute SET + PUBLISH + auto-register project (PUT allows create or update)
    const result = await redisService.setConfigAndPublish(key, String(value));
    
    res.json({
      success: true,
      key,
      value: String(value),
      operations: {
        set: result.set === 'OK',
        published: result.published,
        projectRegistered: result.projectRegistered !== null ? result.projectRegistered >= 0 : null
      }
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /redis/:key - Delete configuration value
router.delete('/:key', async (req, res, next) => {
  try {
    const { key } = req.params;

    // Check if key exists before deletion
    const existsBefore = await redisService.get(key);
    
    // Execute DELETE + PUBLISH
    const result = await redisService.deleteConfigAndPublish(key);
    
    res.json({
      success: true,
      key,
      existed: existsBefore !== null,
      operations: {
        deleted: result.deleted, // del returns number of keys deleted
        published: result.published // publish returns number of clients that received the message
      }
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /redis/:key/children - Delete all child keys under a namespace (group deletion)
router.delete('/:key/children', async (req, res, next) => {
  try {
    const { key } = req.params;

    // Execute namespace children deletion
    const result = await redisService.deleteNamespaceChildren(key);
    
    res.json({
      success: true,
      namespaceKey: key,
      operations: {
        deleted: result.deleted, // number of child keys deleted
        published: result.published, // number of deletion events published
        childKeys: result.childKeys, // list of deleted child keys
        preservedParent: result.preservedParent // whether parent key was preserved
      }
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;