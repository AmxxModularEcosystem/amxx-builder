#!/usr/bin/env node
'use strict';

/**
 * Faithful mock of amxxpc (AMX Mod X Pawn compiler) — 1.10-shaped CLI contract.
 *
 * Behavior mirrors the REAL compiler as verified against the actual 1.10.0.5479
 * source (compiler/libpc300/sc1.c + compiler/amxxpc/amxxpc.cpp) and binary:
 *
 *  - Accepts the full documented flag surface with attached values only
 *    (`-o<file>`, `-o=<file>`, `-o:<file>`; space-separated `-o <file>` is
 *    broken in the real compiler too).
 *  - Rejects on Linux: `-D...` (dead dos_setdrive code), `-H...` (Windows-only),
 *    unknown flags, and bad values (`-A` not a multiple of 4, `-S`/`-X` <= 64,
 *    `-d` not in 0..3, `-t` <= 0) — prints the full Options text + exit 1,
 *    no `.amxx` produced.
 *  - `-?`/`--help` only as argv[1] → partial help, exit 0.
 *  - No args → short usage, exit 1 (1.8.3+ behavior).
 *  - Success: writes a dummy `.amxx` at the `-o` path (appending `x` to the
 *    `.amx` name unless it already ends in `.amxx`/`.AMXX`, mirroring the
 *    wrapper rename), prints a summary, exit 0.
 *  - `#error <msg>` in the source → compile failure: prints the error, exit 1,
 *    no `.amxx` (matches the real preprocessor directive).
 *  - `-a` → assembler output only: prints "Assembler output succeeded", exit 0,
 *    no `.amxx`.
 *  - `sym=val` args are defines; `@<file>` is a response file (whitespace-split).
 *  - Writes the parsed invocation to `<outPath>.args.json` so tests can assert
 *    the exact flags the builder passed.
 *
 * Version-parameterizable via AMXB_MOCK_VERSION=1.9 (drops `-sui`) or
 * AMXB_MOCK_VERSION=1.8.2 (drops `-sui` and the `-E`/`-h` flags).
 */

const fs   = require('fs');
const path = require('path');

const VERSION = process.env.AMXB_MOCK_VERSION || '1.10.0.5479';
const HAS_SUI = !/^1\.(8|9)/.test(VERSION);            // -sui added in 1.10
const HAS_EH  = !/^1\.8\.2/.test(VERSION);             // -E and -h added in 1.8.3

const BANNER = [
  `AMX Mod X Compiler ${VERSION}`,
  'Copyright (c) 1997-2006 ITB CompuPhase',
  'Copyright (c) 2004-2013 AMX Mod X Team',
].join('\n');

const OPTIONS = [
  '         -A<num>  alignment in bytes of the data segment and the stack',
  '         -a       output assembler code',
  '         -C[+/-]  compact encoding for output file (default=-)',
  '         -c<name> codepage name or number; e.g. 1252 for Windows Latin-1',
  '         -Dpath   active directory path (only if dos_setdrive defined)',
  '         -d0      no symbolic information, no run-time checks',
  '         -d1      [default] run-time checks, no symbolic information',
  '         -d2      full debug information and dynamic checking',
  '         -d3      full debug information, dynamic checking, no optimization',
  '         -e<name> set name of error file (quiet compile)',
  (HAS_EH ? '         -E       treat warnings as errors' : null),
  '         -H<hwnd> window handle to send a notification message on finish (Windows only)',
  (HAS_EH ? '         -h       show include file list' : null),
  '         -i<name> path for include files',
  '         -l       create list file (preprocess only)',
  '         -o<name> set base name of (P-code) output file',
  '         -p<name> set name of "prefix" file',
  '         -r[name] write cross reference report to console or to specified file',
  '         -S<num>  stack/heap size in cells (default=4096)',
  '         -s<num>  skip lines from the input file',
  (HAS_SUI ? '         -sui[+/-] show stack usage info' : null),
  '         -t<num>  TAB indent size (in character positions, default=8)',
  '         -v<num>  verbosity level; 0=quiet, 1=normal, 2=verbose (default=1)',
  '         -w<num>  disable a specific warning by its number',
  '         -X<num>  abstract machine size limit in bytes',
  '         -\\       use \'\\\' for escape characters',
  '         -^       use \'^\' for escape characters',
  '         -;[+/-]  require a semicolon to end each statement (default=-)',
  '         -([+/-]  require parantheses for function invocation (default=+)',
  '         sym=val  define constant "sym" with value "val"',
].filter(Boolean);

const SHORT_HELP = [
  '         -A<num>  alignment in bytes of the data segment and the stack',
  '         -a       output assembler code',
  '         -C[+/-]  compact encoding for output file (default=-)',
  '         -c<name> codepage name or number; e.g. 1252 for Windows Latin-1',
  '         -Dpath   active directory path (only if dos_setdrive defined)',
  '         -d0..-d3 debug level',
  '         -e<name> set name of error file (quiet compile)',
  '         -H<hwnd> window handle to send a notification message on finish (Windows only)',
  '         -i<name> path for include files',
  '         -l       create list file (preprocess only)',
  '         -o<name> set base name of (P-code) output file',
  '         -p<name> set name of "prefix" file',
  '         -r[name] write cross reference report to console or to specified file',
].join('\n');

function usage() {
  process.stdout.write(`${BANNER}\n\nUsage:   pawncc <filename> [filename...] [options]\n\nOptions:\n${OPTIONS.join('\n')}\n`);
}

function fail(msg) {
  process.stdout.write(`${BANNER}\n\nUsage:   pawncc <filename> [filename...] [options]\n\nOptions:\n${OPTIONS.join('\n')}\n`);
  if (msg) process.stdout.write(`\n${msg}\n`);
  process.exit(1);
}

// option_value(): `-o<v>`, `-o=<v>`, `-o:<v>` all yield v (attached only).
function optionValue(arg) {
  return (arg[2] === '=' || arg[2] === ':') ? arg.slice(3) : arg.slice(2);
}

// toggle_option(): no suffix → toggle; `-` → off; `+` → on.
function toggleOption(value, current) {
  if (value === '-') return false;
  if (value === '+') return true;
  return !current;
}

function parseResponseFile(tokens, file) {
  const raw = fs.readFileSync(file, 'utf8');
  return raw.split(/\s+/).filter(Boolean).concat(tokens);
}

function main() {
  const argv = process.argv.slice(2);

  if (argv.length === 0) {
    process.stdout.write(`${BANNER}\n\nUsage: <file.sma> [options]\nUse -? or --help to see full options\n`);
    process.exit(1);
  }
  if (argv[0] === '-?' || argv[0] === '--help') {
    process.stdout.write(`${BANNER}\n\nUsage:   pawncc <filename> [filename...] [options]\n\nOptions:\n${SHORT_HELP}\n`);
    process.exit(0);
  }

  // Response file support: `@<file>` tokens are whitespace-split and prepended.
  let tokens = argv;
  for (const t of argv) {
    if (t.startsWith('@')) tokens = parseResponseFile(tokens.filter((x) => x !== t), t.slice(1));
  }

  const state = {
    source: null, outPath: null, includes: [], defines: [],
    debug: 1, verbosity: 1, assembler: false, listing: false,
    warningsAsErrors: false, showIncludes: false, stkusage: false,
  };

  for (const arg of tokens) {
    if (arg.startsWith('-') && arg.length > 1) {
      const opt = arg[1];
      const val = optionValue(arg);

      switch (opt) {
        case 'A': { const n = Number(val); if (n % 4 !== 0) fail(`-A<num> must be a multiple of 4 (got ${val})`); break; }
        case 'a': if (val !== '') fail('-a takes no value'); state.assembler = true; break;
        case 'C': state.compact = toggleOption(val, !!state.compact); break;
        case 'c': state.codepage = val; break;
        case 'd': { const n = Number(val); if (![0, 1, 2, 3].includes(n)) fail(`-d must be 0..3 (got ${val})`); state.debug = n; break; }
        case 'D': fail('-D is not a valid option on this platform'); break;
        case 'e': state.errfile = val; break;
        case 'E': if (!HAS_EH) fail('-E is not a valid option'); state.warningsAsErrors = true; break;
        case 'H': fail('-H is not a valid option on this platform'); break;
        case 'h': if (!HAS_EH) fail('-h is not a valid option'); state.showIncludes = true; break;
        case 'i': state.includes.push(val); break;
        case 'l': if (val !== '') fail('-l takes no value'); state.listing = true; break;
        case 'o': state.outPath = val; break;
        case 'p': state.prefix = val; break;
        case 'r': state.report = val || true; break;
        case 'S': { const n = Number(val); if (!(n > 64)) fail(`-S<num> must be > 64 (got ${val})`); break; }
        case 's':
          if (HAS_SUI && val.startsWith('ui')) { state.stkusage = toggleOption(val.slice(2), state.stkusage); break; }
          state.skip = Number(val) || 0;
          break;
        case 't': { const n = Number(val); if (!(n > 0)) fail(`-t<num> must be > 0 (got ${val})`); state.tabsize = n; break; }
        case 'v': state.verbosity = /^\d/.test(val) ? Number(val) : 2; break;
        case 'w': state.warn = val; break;
        case 'X': { const n = Number(val); if (!(n > 64)) fail(`-X<num> must be > 64 (got ${val})`); break; }
        case '\\': case '^': state.ctrlchar = opt; break;
        case ';': state.needsemicolon = toggleOption(val, !!state.needsemicolon); break;
        case '(': state.optproccall = !toggleOption(val, true); break;
        default: fail(`unknown option: -${opt}`);
      }
    } else if (arg.includes('=')) {
      state.defines.push(arg);                       // sym=val constant define
    } else if (state.source === null) {
      state.source = arg;
    }
  }

  if (!state.source) fail('no input file');
  if (!state.outPath) {
    state.outPath = path.basename(state.source).replace(/\.[^.]*$/, '') + '.amxx';
  }

  // Record the invocation for test assertions.
  try {
    fs.writeFileSync(state.outPath + '.args.json', JSON.stringify(state, null, 2));
  } catch (_) { /* record write is best-effort */ }

  // `#error <msg>` in the source → compile error, no output, exit 1.
  let srcText = '';
  try { srcText = fs.readFileSync(state.source, 'utf8'); } catch (e) { fail(`can't read file: ${state.source}`); }
  const errLine = srcText.split('\n').findIndex((l) => l.trim().startsWith('#error'));
  if (errLine !== -1) {
    const msg = (srcText.split('\n')[errLine].trim().match(/^#error\s*(.*)/) || [])[1] || 'error';
    process.stdout.write(`${state.source}(${errLine + 1}) : error 001: ${msg}\n`);
    process.exit(1);
  }

  if (state.assembler) {
    process.stdout.write(`${BANNER}\n\nAssembler output succeeded\n`);
    process.exit(0);
  }

  // Mirror the wrapper rename: core writes <name>.amx, wrapper appends "x"
  // unless the name already ends in .amxx/.AMXX.
  let out = state.outPath;
  if (!/\.amxx$/i.test(out)) out = out.replace(/\.[^.]*$/, '') + '.amxx';
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, 'MOCK AMXX');

  process.stdout.write(
    `${BANNER}\n\n` +
    `Header size:            138 bytes\n` +
    `Code size:                0 bytes\n` +
    `Data size:                0 bytes\n` +
    `Stack/heap size:      16384 bytes; estimated max. usage=2 cells (8 bytes)\n` +
    `Total requirements:   16522 bytes\n` +
    `Done.\n`
  );
  process.exit(0);
}

main();
