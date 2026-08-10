'use strict';

/**
 * Shared AJV-based manifest validation.
 *
 * Loads the JSON schema once (cached), compiles AJV with all errors and
 * format support. Used by both manifest.js (parse-time validation, throws)
 * and validate.js (diagnostic validation, returns structured result).
 */

const fs   = require('fs');
const path = require('path');
const Ajv     = require('ajv');
const addFormats = require('ajv-formats');

const SCHEMA_PATH = path.join(__dirname, '..', 'schema', 'amxbuild.schema.json');

let schemaCache = null;
try {
  if (fs.existsSync(SCHEMA_PATH)) {
    schemaCache = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  }
} catch { /* no schema file — AJV validation skipped */ }

/**
 * Validate a raw manifest object against the JSON schema.
 *
 * @param {object} raw  — parsed YAML manifest merged with defaults
 * @returns {{ valid: boolean, errors: Array<{ path: string, message: string }> }}
 */
function validateManifest(raw) {
  if (!schemaCache) return { valid: true, errors: [] };

  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(schemaCache);
  const valid = validate(raw);

  if (valid) return { valid: true, errors: [] };

  return {
    valid: false,
    errors: validate.errors.map((e) => ({
      path: e.instancePath || '(root)',
      message: e.message,
    })),
  };
}

function getManifestSchema() {
  return schemaCache;
}

module.exports = { validateManifest, getManifestSchema };
