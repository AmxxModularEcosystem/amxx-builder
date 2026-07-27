'use strict';

const fs   = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const Ajv     = require('ajv');
const addFormats = require('ajv-formats');

const { loadDefaultsRaw, deepMerge } = require('./manifest');

const SCHEMA_PATH = path.join(__dirname, '..', 'schema', 'amxbuild.schema.json');

let schemaCache = null;
try {
  if (fs.existsSync(SCHEMA_PATH)) {
    schemaCache = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  }
} catch { /* no schema — skip AJV validation */ }

/**
 * Validate a manifest file and return structured diagnostics.
 * Never throws — returns { valid, errors, warnings }.
 */
function validateManifestFile(manifestPath) {
  const errors   = [];
  const warnings = [];

  // 1. File exists
  const absPath = path.resolve(manifestPath);
  if (!fs.existsSync(absPath)) {
    errors.push({ path: '(root)', message: `Manifest not found: ${absPath}` });
    return { valid: false, errors, warnings };
  }

  // 2. Parse YAML
  let projectRaw;
  try {
    projectRaw = yaml.load(fs.readFileSync(absPath, 'utf8'));
  } catch (err) {
    errors.push({ path: '(root)', message: `YAML parse error: ${err.message}` });
    return { valid: false, errors, warnings };
  }

  if (!projectRaw || typeof projectRaw !== 'object' || Array.isArray(projectRaw)) {
    errors.push({ path: '(root)', message: 'Manifest is empty or not a valid YAML object' });
    return { valid: false, errors, warnings };
  }

  // 3. Check name
  if (!projectRaw.name || typeof projectRaw.name !== 'string') {
    errors.push({ path: '/name', message: 'Missing required field "name"' });
  }

  // 4. Merge with defaults
  const defaults = loadDefaultsRaw();
  const raw = deepMerge(defaults, projectRaw);

  // 5. AJV schema validation
  if (schemaCache) {
    try {
      const ajv = new Ajv({ allErrors: true });
      addFormats(ajv);
      const validate = ajv.compile(schemaCache);
      const valid = validate(raw);
      if (!valid) {
        for (const e of validate.errors) {
          errors.push({
            path: e.instancePath || '(root)',
            message: e.message,
          });
        }
      }
    } catch (err) {
      errors.push({ path: '(root)', message: `Schema validation error: ${err.message}` });
    }
  }

  // 6. version must be a string (common mistake: YAML parses unquoted as number)
  if (raw.version != null && typeof raw.version !== 'string') {
    errors.push({
      path: '/version',
      message: `"version" must be a quoted string in YAML, got ${typeof raw.version}`,
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

module.exports = { validateManifestFile };
