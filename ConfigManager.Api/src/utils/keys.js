// Allowlist for configuration keys and project names.
//
// Keys follow the documented <project>:<namespace>:<setting> model, so letters,
// digits, dots, underscores, colons and hyphens are all that is ever needed.
// Everything else is rejected at the route boundary — most importantly the Redis
// glob metacharacters (*, ?, [), which would otherwise turn a key into a
// wildcard when the service interpolates it into a SCAN/KEYS MATCH pattern.
const CONFIG_KEY_PATTERN = /^[a-zA-Z0-9._:-]+$/;

function isValidConfigKey(value) {
  return typeof value === 'string' && CONFIG_KEY_PATTERN.test(value);
}

module.exports = {
  isValidConfigKey
};
