'use strict';

const fs   = require('fs');
const path = require('path');

const logger = require('../logger');

const TEMPLATES_DIR = path.join(__dirname, '..', '..', 'templates');
const SCHEMA_URL    = 'https://raw.githubusercontent.com/AmxxModularEcosystem/amxx-builder/master/schema/amxbuild.schema.json';

// Written to .vscode/extensions.json by `amxb init --vscode`.
const VSCODE_EXTENSIONS = [
  'Faktor.amxx-pawn-all-in',
  'amxx-modular-ecosystem.amxb-vscode',
];

// Auto-discovered by opencode (.opencode/plugin/*.js). Registers skills from all
// three sources in the config hook, with no machine-specific paths in opencode.json.
const OPENCODE_BRIDGE_FILE   = path.join('.opencode', 'plugin', 'amxb-skills.js');
const OPENCODE_BRIDGE_PLUGIN = `// Bridge: exposes amxb (amxx-builder) skills to opencode from three sources:
//   1. builder-bundled skills, via "amxb skills-dir"
//   2. the current project's own "skills:" from amxbuild.yml
//   3. deps/repos skills read from their manifests; missing ones are fetched
//      from the network on demand ("amxb opencode-skills")
// No machine-specific paths are stored in opencode.json: amxb resolves its own
// install and cache directories at every opencode start, like the MCP entry does.
import { execSync } from "node:child_process";

export default async function amxbSkills() {
  return {
    config(cfg) {
      cfg.skills = cfg.skills || {};
      cfg.skills.paths = cfg.skills.paths || [];
      const exe = process.platform === "win32" ? "amxb.cmd" : "amxb";
      const add = (p) => {
        if (p && !cfg.skills.paths.includes(p)) cfg.skills.paths.push(p);
      };
      try {
        add(execSync(exe + " skills-dir", { encoding: "utf8" }).trim());
      } catch {}
      try {
        const out = execSync(exe + " opencode-skills", { encoding: "utf8", timeout: 180000 });
        for (const line of out.split("\\n")) add(line.trim());
      } catch {}
    },
  };
}
`;

async function runInitInteractive(options) {
  const { Input, Confirm } = require('enquirer');
  const defaultName = options.name || path.basename(process.cwd());

  const name = await new Input({
    name: 'name',
    message: 'Project name',
    initial: defaultName,
  }).run();

  await new Input({
    name: 'description',
    message: 'Project description (optional)',
    initial: '',
  }).run();

  const doWorkflow = await new Confirm({
    name: 'workflow',
    message: 'Generate GitHub CI workflow?',
    initial: false,
  }).run();

  const doPlugin = await new Confirm({
    name: 'plugin',
    message: 'Create a plugin .sma file?',
    initial: true,
  }).run();
  const pluginName = doPlugin ? await new Input({
    name: 'pluginName',
    message: 'Plugin filename (without .sma)',
    initial: name,
  }).run() : null;

  const doGitignore = await new Confirm({
    name: 'gitignore',
    message: 'Create .gitignore?',
    initial: true,
  }).run();

  const doDeploy = await new Confirm({
    name: 'deploy',
    message: 'Create .env with deploy stubs?',
    initial: false,
  }).run();

  const doOpencode = await new Confirm({
    name: 'opencode',
    message: 'Create .opencode/ (opencode.json MCP config + skills bridge plugin)?',
    initial: false,
  }).run();

  const doScript = await new Confirm({
    name: 'script',
    message: 'Create build.bat / build.sh quick-build scripts?',
    initial: true,
  }).run();

  const doVscode = await new Confirm({
    name: 'vscode',
    message: 'Create .vscode/extensions.json with recommended extensions?',
    initial: true,
  }).run();

  const actions = [];
  actions.push('amxbuild.yml');
  if (doWorkflow) actions.push('.github/workflows/ci.yml');
  if (pluginName) actions.push(`amxmodx/scripting/${pluginName}.sma`);
  if (doGitignore) actions.push('.gitignore');
  if (doDeploy) actions.push('.env');
  if (doOpencode) actions.push('.opencode/opencode.json');
  if (doScript) actions.push('build.bat', 'build.sh');
  if (doVscode) actions.push('.vscode/extensions.json');

  logger.info('Creating:');
  for (const a of actions) logger.dim(`  ${a}`);

  const version = require('../../package.json').version;
  const actionTag = `v${version.split('.')[0]}`;

  writeManifest(name, options);

  if (doWorkflow) {
    const dest = path.join('.github', 'workflows', 'ci.yml');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    writeIfAbsent(dest, renderTemplate('init-workflow.yml', { actionTag }), options.force);
  }

  if (pluginName) {
    const dest = path.join('amxmodx', 'scripting', `${pluginName}.sma`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    writeIfAbsent(dest, '', options.force);
  }

  if (doGitignore) {
    writeGitignore(options.force);
  }

  if (doDeploy) {
    writeIfAbsent('.env', renderTemplate('init-deploy.env'), options.force);
  }

  if (doOpencode) {
    writeOpencodeConfig();
    writeOpencodeBridge(options.force);
  }

  if (doScript) {
    writeBuildScripts(options.force);
  }

  if (doVscode) {
    writeVscodeExtensions();
  }
}

function runInit(options) {
  const pkgName = options.name || path.basename(process.cwd());
  const version = require('../../package.json').version;
  const actionTag = `v${version.split('.')[0]}`;

  writeManifest(pkgName, options);

  if (options.workflow || options.ci) {
    const dest = path.join('.github', 'workflows', 'ci.yml');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    writeIfAbsent(dest, renderTemplate('init-workflow.yml', { actionTag }), options.force);
  }

  if (options.plugin) {
    const dest = path.join('amxmodx', 'scripting', `${options.plugin}.sma`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    writeIfAbsent(dest, '', options.force);
  }

  if (options.gitignore) {
    writeGitignore(options.force);
  }

  if (options.deploy) {
    writeIfAbsent('.env', renderTemplate('init-deploy.env'), options.force);
  }

  if (options.opencode) {
    writeOpencodeConfig();
    writeOpencodeBridge(options.force);
  }

  if (options.script) {
    writeBuildScripts(options.force);
  }

  if (options.vscode || options.vsc) {
    writeVscodeExtensions();
  }
}

// Shared by both init paths; also the .gitignore basis the amxb-migration skill
// reuses, so keep templates/init-gitignore in sync with its step 6.
function writeGitignore(force) {
  return writeIfAbsent('.gitignore', renderTemplate('init-gitignore'), force);
}

function writeBuildScripts(force) {
  const batCreated = writeIfAbsent('build.bat', renderTemplate('init-build.bat').replace(/\r?\n/g, '\r\n'), force);
  const shCreated  = writeIfAbsent('build.sh',  renderTemplate('init-build.sh'), force);

  if (shCreated && process.platform !== 'win32') {
    try {
      fs.chmodSync('build.sh', 0o755);
      logger.dim('  chmod +x build.sh');
    } catch (err) {
      logger.warn(`Could not make build.sh executable: ${err.message}`);
    }
  }

  return batCreated || shCreated;
}

// The manifest is deliberately excluded from a bare --force: an existing
// amxbuild.yml is only replaced when --with-manifest is passed explicitly, so
// `amxb init --force` cannot silently destroy a hand-written manifest.
function writeManifest(name, options) {
  const content = renderTemplate('init-manifest.yml', { name, schemaUrl: SCHEMA_URL });
  const skipHint = options.force && !options.withManifest
    ? 'pass --with-manifest with --force to overwrite it'
    : undefined;
  writeIfAbsent('amxbuild.yml', content, Boolean(options.force && options.withManifest), skipHint);
}

function writeIfAbsent(filePath, content, force, skipHint) {
  const existed = fs.existsSync(filePath);
  if (existed && !force) {
    logger.warn(skipHint ? `${filePath} already exists, skipping (${skipHint})` : `${filePath} already exists, skipping`);
    return false;
  }
  fs.writeFileSync(filePath, content);
  logger.success(existed ? `Overwritten ${filePath}` : `Created ${filePath}`);
  return true;
}

function writeOpencodeConfig() {
  const dir   = '.opencode';
  const file  = path.join(dir, 'opencode.json');
  const mcpKey = 'amxx-dep-resolver';
  const mcpConfig = {
    type: 'local',
    command: ['amxb', 'mcp'],
    enabled: true,
  };

  if (!fs.existsSync(file)) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      mcp: { [mcpKey]: mcpConfig },
    }, null, 2) + '\n');
    logger.success(`Created ${file}`);
    return;
  }

  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    logger.warn(`${file} exists but is invalid JSON, skipping merge`);
    return;
  }

  if (cfg.mcp?.[mcpKey]) {
    logger.warn(`${file} already has MCP config (amxx-dep-resolver), skipping`);
    return;
  }

  cfg.mcp = cfg.mcp || {};
  cfg.mcp[mcpKey] = mcpConfig;
  cfg.$schema = cfg.$schema || 'https://opencode.ai/config.json';
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  logger.success(`Updated ${file} with MCP config (amxb mcp)`);
}

function writeOpencodeBridge(force) {
  fs.mkdirSync(path.dirname(OPENCODE_BRIDGE_FILE), { recursive: true });
  writeIfAbsent(OPENCODE_BRIDGE_FILE, OPENCODE_BRIDGE_PLUGIN, force);
}

// The extensions file is shared with the user's own editor setup, so it is
// merged rather than overwritten: existing recommendations are preserved and
// only the missing amxb entries are appended.
function writeVscodeExtensions() {
  const dir  = '.vscode';
  const file = path.join(dir, 'extensions.json');

  if (!fs.existsSync(file)) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ recommendations: VSCODE_EXTENSIONS }, null, 2) + '\n');
    logger.success(`Created ${file}`);
    return;
  }

  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    logger.warn(`${file} exists but is invalid JSON, skipping`);
    return;
  }

  if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) {
    logger.warn(`${file} is not a JSON object, skipping`);
    return;
  }

  const current = Array.isArray(cfg.recommendations) ? cfg.recommendations : [];
  const missing = VSCODE_EXTENSIONS.filter((id) => !current.includes(id));

  if (missing.length === 0) {
    logger.warn(`${file} already recommends the amxb extensions, skipping`);
    return;
  }

  cfg.recommendations = current.concat(missing);
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  logger.success(`Updated ${file} with recommended extensions`);
}

function renderTemplate(name, vars = {}) {
  let content = fs.readFileSync(path.join(TEMPLATES_DIR, name), 'utf8');
  for (const [key, value] of Object.entries(vars)) {
    content = content.replaceAll(`{{${key}}}`, value);
  }
  return content;
}

module.exports = { runInit, runInitInteractive };
