'use strict';

const fs   = require('fs');
const path = require('path');

const logger = require('../logger');

const TEMPLATES_DIR = path.join(__dirname, '..', '..', 'templates');
const SCHEMA_URL    = 'https://raw.githubusercontent.com/AmxxModularEcosystem/amxx-builder/master/schema/amxbuild.schema.json';

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
    message: 'Create .opencode/opencode.json with MCP config (amxb mcp)?',
    initial: false,
  }).run();

  const doScript = await new Confirm({
    name: 'script',
    message: 'Create build.bat / build.sh quick-build scripts?',
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

  logger.info('Creating:');
  for (const a of actions) logger.dim(`  ${a}`);

  const version = require('../../package.json').version;
  const actionTag = `v${version.split('.')[0]}`;

  writeIfAbsent('amxbuild.yml', renderTemplate('init-manifest.yml', { name, schemaUrl: SCHEMA_URL }));

  if (doWorkflow) {
    const dest = path.join('.github', 'workflows', 'ci.yml');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    writeIfAbsent(dest, renderTemplate('init-workflow.yml', { actionTag }));
  }

  if (pluginName) {
    const dest = path.join('amxmodx', 'scripting', `${pluginName}.sma`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    writeIfAbsent(dest, '');
  }

  if (doGitignore) {
    writeIfAbsent('.gitignore', [
      '*.amxx', '*.zip', '.env', '.amxb-cache', '.claude', 'build', 'dist', '',
    ].join('\n'));
  }

  if (doDeploy) {
    writeIfAbsent('.env', renderTemplate('init-deploy.env'));
  }

  if (doOpencode) {
    writeOpencodeConfig();
  }

  if (doScript) {
    writeBuildScripts();
  }
}

function runInit(options) {
  const pkgName = options.name || path.basename(process.cwd());
  const version = require('../../package.json').version;
  const actionTag = `v${version.split('.')[0]}`;

  writeIfAbsent('amxbuild.yml', renderTemplate('init-manifest.yml', { name: pkgName, schemaUrl: SCHEMA_URL }));

  if (options.workflow || options.ci) {
    const dest = path.join('.github', 'workflows', 'ci.yml');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    writeIfAbsent(dest, renderTemplate('init-workflow.yml', { actionTag }));
  }

  if (options.plugin) {
    const dest = path.join('amxmodx', 'scripting', `${options.plugin}.sma`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    writeIfAbsent(dest, '');
  }

  if (options.gitignore) {
    writeIfAbsent('.gitignore', [
      '*.amxx', '*.zip', '.env', '.amxb-cache', '.claude', 'build', 'dist', '',
    ].join('\n'));
  }

  if (options.deploy) {
    writeIfAbsent('.env', renderTemplate('init-deploy.env'));
  }

  if (options.opencode) {
    writeOpencodeConfig();
  }

  if (options.script) {
    writeBuildScripts();
  }
}

function writeBuildScripts() {
  const batCreated = writeIfAbsent('build.bat', renderTemplate('init-build.bat').replace(/\r?\n/g, '\r\n'));
  const shCreated  = writeIfAbsent('build.sh',  renderTemplate('init-build.sh'));

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

function writeIfAbsent(filePath, content) {
  if (fs.existsSync(filePath)) {
    logger.warn(`${filePath} already exists, skipping`);
    return false;
  }
  fs.writeFileSync(filePath, content);
  logger.success(`Created ${filePath}`);
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

function renderTemplate(name, vars = {}) {
  let content = fs.readFileSync(path.join(TEMPLATES_DIR, name), 'utf8');
  for (const [key, value] of Object.entries(vars)) {
    content = content.replaceAll(`{{${key}}}`, value);
  }
  return content;
}

module.exports = { runInit, runInitInteractive };
