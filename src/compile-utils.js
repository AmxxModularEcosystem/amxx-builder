'use strict';

const fs   = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// ─── WSL DrvFs/9p input guard ────────────────────────────────────────────────
//
// amxxpc is a 32-bit Linux binary that cannot READ files on WSL DrvFs/9p mounts
// (/mnt/c, /mnt/d, /mnt/j, …). A source or include dir there makes it fail with
// "fatal error 100: cannot read from file" (a directory used as -i aborts it
// with std::bad_alloc), even though the file exists and Node reads it fine.
// Writing output to such a mount works. Catch this up-front and hand back an
// actionable message instead of the cryptic compiler output.

let _isWsl;
let _mountpoints = null;

function isWsl() {
  if (_isWsl !== undefined) return _isWsl;
  _isWsl = false;
  if (process.platform === 'linux') {
    if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) {
      _isWsl = true;
    } else {
      try {
        _isWsl = /microsoft|wsl/i.test(fs.readFileSync('/proc/version', 'utf8'));
      } catch (_) { /* no /proc/version — assume not WSL */ }
    }
  }
  return _isWsl;
}

// "/proc/mounts" text → mountpoints whose fstype is 9p (WSL DrvFs).
// Mountpoints escape spaces/tabs/backslashes as \040 / \011 / \134.
function parse9pMountpoints(mountsText) {
  const out = [];
  for (const line of String(mountsText).split('\n')) {
    const parts = line.split(/\s+/);
    if (parts.length >= 4 && parts[2] === '9p') {
      out.push(parts[1].replace(/\\([0-7]{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8))));
    }
  }
  return out;
}

function get9pMountpoints() {
  if (_mountpoints) return _mountpoints;
  _mountpoints = [];
  if (process.platform === 'linux') {
    try { _mountpoints = parse9pMountpoints(fs.readFileSync('/proc/mounts', 'utf8')); }
    catch (_) { /* no /proc/mounts — nothing to guard */ }
  }
  return _mountpoints;
}

// Compiler argv → the paths amxxpc must READ (source + `-i` include dirs).
// `-o` output paths are ignored — writing to a 9p mount works.
function collectCompilerInputs(args) {
  const inputs = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-i') { if (args[i + 1]) inputs.push(args[++i]); continue; }
    if (arg.startsWith('-i')) { inputs.push(arg.slice(2)); continue; }
    if (arg === '-o') { i++; continue; }
    if (arg.startsWith('-o')) continue;
    if (i === 0 && !arg.startsWith('-')) inputs.push(arg); // source is argv[0]
  }
  return inputs.filter(Boolean);
}

function isUnder(p, dir) {
  const abs = path.resolve(p);
  if (abs === dir) return true;
  return abs.startsWith(dir.endsWith('/') ? dir : dir + '/');
}

function findNonNativeInputs(args, mountpoints) {
  return collectCompilerInputs(args).filter((p) => mountpoints.some((mp) => isUnder(p, mp)));
}

function nonNativeInputError(inputs) {
  return [
    'amxxpc cannot read files on WSL DrvFs/9p mounts (/mnt/*).',
    'Unreadable input(s):',
    ...inputs.map((p) => `  ${p}`),
    'The compiler is a 32-bit Linux binary; on these mounts it fails with',
    '"fatal error 100: cannot read from file" (an include directory aborts it with',
    'std::bad_alloc), although the file exists and Node can read it.',
    'Run the build from the Linux-native filesystem instead — copy the project to',
    'e.g. ~/ (the ~/.cache/amxx-builder cache is shared, nothing re-downloads), or',
    'run the build on Windows.',
  ].join('\n');
}

/**
 * Preflight for a compiler invocation. On WSL, when the source or any `-i`
 * include dir sits on a DrvFs/9p mount, `ok` is false and `error` is a
 * ready-to-print explanation. `wsl`/`mountpoints` are injectable for tests.
 */
function checkCompilerInputs(args, { wsl = isWsl(), mountpoints = get9pMountpoints() } = {}) {
  if (!wsl || !mountpoints.length) return { ok: true, inputs: [], error: null };
  const inputs = findNonNativeInputs(args, mountpoints);
  if (!inputs.length) return { ok: true, inputs: [], error: null };
  return { ok: false, inputs, error: nonNativeInputError(inputs) };
}

/**
 * Unified compiler spawn. Interface-agnostic core helper (used by the CLI build,
 * watch mode and the MCP compile tool).
 *
 * ALWAYS resolves — never rejects:
 *  - WSL + input on a DrvFs/9p mount (/mnt/*): { status: 1, output: <explanation> }
 *  - on spawn error (ENOENT etc.): { status: 1, output: String(err.message) }
 *  - on close (including non-zero exit): { status: code, output: stdout+stderr merged }
 *
 * On linux, prepends the compiler's directory to LD_LIBRARY_PATH (32-bit
 * amxxpc needs its bundled libs). windowsHide: true keeps a console from
 * flashing on Windows.
 */
function spawnCompiler(cmd, args, { maxBuffer = 10 * 1024 * 1024, ...guardOptions } = {}) {
  const guard = checkCompilerInputs(args, guardOptions);
  if (!guard.ok) {
    return Promise.resolve({ status: 1, output: guard.error });
  }
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

/**
 * Turns manifest defines (e.g. ['DEBUG', 'VERSION=2']) into amxxpc CLI args.
 *
 * amxxpc (Pawn compiler fork) does NOT accept `-D<name>` defines: on Linux the
 * -D flag is compiled out (dead dos_setdrive code) and rejected; on Windows it
 * is silently treated as chdir. Its only CLI define syntax is a bare
 * `sym=val` argument (sc1.c parseoptions). A value-less flag is therefore
 * normalized to `NAME=1` (semantics of `-DNAME` elsewhere: `#if NAME` and
 * `#if defined NAME` both see it enabled).
 */
function buildDefineArgs(defines) {
  return (defines || []).map((d) => (d.includes('=') ? d : `${d}=1`));
}

module.exports = { spawnCompiler, buildIncludeArgs, buildDefineArgs, checkCompilerInputs, parse9pMountpoints };
