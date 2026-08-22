'use strict';

const path = require('path');

const logger = require('../logger');
const { parseManifest, resolveGithubToken } = require('../manifest');
const { resolveRepoRefs } = require('../repo-fetcher');
const { buildDepTree, assembleRootDeps } = require('../deps-tree');
const { resolveManifestPath, loadEnv } = require('./shared');

async function runDepsTree(options) {
  const manifestPath = options.manifest ? path.resolve(options.manifest) : resolveManifestPath(undefined);
  loadEnv(manifestPath);

  const noFetch = options.fetch === false;
  const asJson  = options.json || false;
  const cycleOnly = options.cycleOnly || false;

  const manifest = parseManifest(manifestPath);

  await resolveRepoRefs(manifest.repos, (repo) => resolveGithubToken(manifest, repo));

  const { rootDeps, getDepsOverride } = assembleRootDeps(manifest);

  const tree = await buildDepTree(rootDeps, {
    tokenFor: (repo) => resolveGithubToken(manifest, repo),
    noFetch,
    depth:   Number.isInteger(options.depth) ? options.depth : 0,
    from:    'manifest',
    getDepsOverride,
  });

  const filtered = cycleOnly ? filterCycles(tree) : tree;

  if (asJson) {
    process.stdout.write(JSON.stringify(filtered, null, 2) + '\n');
    return;
  }

  printTree(filtered);
}

function printTree(tree) {
  if (!tree.dependencies || tree.dependencies.length === 0) {
    logger.info('No dependencies');
    return;
  }
  logger.info('Dependency tree:');
  for (const node of tree.dependencies) {
    printNode(node, '', true);
  }
}

function printNode(node, prefix, isLast) {
  const connector = isLast ? '└── ' : '├── ';
  const childPrefix = isLast ? '    ' : '│   ';

  const tag = buildNodeTag(node);
  logger.dim(`${prefix}${connector}${node.repo}@${node.ref || 'HEAD'}${tag}`);

  if (node.cycle) return;

  for (let i = 0; i < node.dependencies.length; i++) {
    printNode(node.dependencies[i], prefix + childPrefix, i === node.dependencies.length - 1);
  }
}

function buildNodeTag(node) {
  const parts = [];
  if (node.from)           parts.push(`from ${node.from}`);
  if (node.resolvedRef && node.ref !== node.resolvedRef) {
    parts.push(`→ ${node.resolvedRef}`);
  }
  if (node.cycle)          parts.push('⚠ cycle');
  if (node.shared)         parts.push('(shared)');
  if (node.error)          parts.push(`✗ ${node.error}`);
  return parts.length ? `  (${parts.join(', ')})` : '';
}

function filterCycles(tree) {
  const collect = [];
  function walk(nodes) {
    for (const n of nodes) {
      if (n.cycle) collect.push(n);
      else walk(n.dependencies);
    }
  }
  walk(tree.dependencies || []);
  return { dependencies: collect };
}

module.exports = { runDepsTree };
