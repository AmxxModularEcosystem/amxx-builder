'use strict';

const fs   = require('fs');
const path = require('path');
const { execFile } = require('child_process');

/**
 * Unified compiler spawn. Interface-agnostic core helper (used by the CLI build,
 * watch mode and the MCP compile tool).
 *
 * ALWAYS resolves — never rejects:
 *  - on spawn error (ENOENT etc.): { status: 1, output: String(err.message) }
 *  - on close (including non-zero exit): { status: code, output: stdout+stderr merged }
 *
 * On linux, prepends the compiler's directory to LD_LIBRARY_PATH (32-bit
 * amxxpc needs its bundled libs). windowsHide: true keeps a console from
 * flashing on Windows.
 */
function spawnCompiler(cmd, args, { maxBuffer = 10 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    if (process.platform === 'linux') {
      const compilerDir = path.dirname(cmd);
      env.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH
        ? `${compilerDir}:${env.LD_LIBRARY_PATH}`
        : compilerDir;
    }
    execFile(cmd, args, { env, windowsHide: true, maxBuffer }, (err, stdout, stderr) => {
      if (err) {
        // execFile sets err.code to a number when the process ran and exited
        // non-zero (or was signal-killed → null); string codes (ENOENT, …)
        // and ERR_CHILD_PROCESS_STDIO_MAXBUFFER are spawn/runtime failures.
        if (typeof err.code === 'number') {
          resolve({ status: err.code, output: String(stdout || '') + String(stderr || '') });
        } else {
          resolve({ status: 1, output: String(err.message || err) });
        }
        return;
      }
      resolve({ status: 0, output: String(stdout || '') + String(stderr || '') });
    });
  });
}

/**
 * Assembles the `-i<dir>` compiler include-flag array in the canonical order:
 * scripting dir → local include/ (if it exists) → collected include dir (if it
 * exists) → each entry of includeDirs. Single source of truth for both the CLI
 * build paths and the MCP compile tool.
 */
function buildIncludeArgs({ scriptingDir, localIncDir, collectedIncDir, includeDirs }) {
  const includes = [];
  includes.push(`-i${scriptingDir}`);
  if (localIncDir && fs.existsSync(localIncDir))     includes.push(`-i${localIncDir}`);
  if (collectedIncDir && fs.existsSync(collectedIncDir)) includes.push(`-i${collectedIncDir}`);
  for (const d of (includeDirs || []))               includes.push(`-i${d}`);
  return includes;
}

/** Turns manifest defines (e.g. ['DEBUG']) into `-DDEBUG` compiler flags. */
function buildDefineArgs(defines) {
  return (defines || []).map((d) => `-D${d}`);
}

module.exports = { spawnCompiler, buildIncludeArgs, buildDefineArgs };
