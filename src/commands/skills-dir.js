'use strict';

const fs   = require('fs');
const path = require('path');

// Absolute path to the skills/ directory bundled with this amxb installation.
// Resolved relative to the running code, so it works for any install method
// (npm -g, install.sh/ps1, linked dev checkout) without consulting npm.
const SKILLS_DIR = path.join(__dirname, '..', '..', 'skills');

function runSkillsDir() {
  if (!fs.existsSync(SKILLS_DIR)) {
    process.stderr.write(`skills directory not found: ${SKILLS_DIR}\n`);
    process.exitCode = 1;
    return;
  }
  // Pure stdout — consumers (e.g. the opencode bridge plugin) parse exactly this line.
  process.stdout.write(SKILLS_DIR + '\n');
}

module.exports = { runSkillsDir, SKILLS_DIR };
