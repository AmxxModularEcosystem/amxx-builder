'use strict';

/**
 * Minimal GoldSrc (HL1 / CS 1.6) UDP RCON client.
 *
 * Protocol:
 *   1. Client → Server: \xff\xff\xff\xff challenge rcon\n
 *   2. Server → Client: \xff\xff\xff\xff challenge rcon <number>\n
 *   3. Client → Server: \xff\xff\xff\xff rcon <number> "<password>" "<command>"\n
 *   4. Server → Client: \xff\xff\xff\xff <response>\n
 */

const dgram = require('dgram');
const logger = require('./logger');

const HL_HEADER = Buffer.from([0xff, 0xff, 0xff, 0xff]);

function makePacket(str) {
  return Buffer.concat([HL_HEADER, Buffer.from(str + '\n', 'utf8')]);
}

async function sendRcon({ host, port, password, command }, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    let settled = false;

    const done = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.close(() => {});
      err ? reject(err) : resolve(result);
    };

    const timer = setTimeout(
      () => done(new Error(`RCON timeout (${host}:${port})`)),
      timeoutMs
    );

    sock.on('error', done);

    sock.on('message', (buf) => {
      if (buf.length < 5) return;
      // Strip null bytes (GoldSrc packets are null-terminated) then whitespace
      const body = buf.slice(4).toString('utf8').replace(/\0/g, '').trim();

      if (body.startsWith('challenge rcon ')) {
        const challenge = body.split(' ')[2];
        const cmd = makePacket(`rcon ${challenge} "${password}" "${command}"`);
        sock.send(cmd, 0, cmd.length, port, host);
        return;
      }

      // All non-challenge responses are print packets with a 1-byte type prefix — strip it
      const text = body.slice(1).trim();
      logger.verbose(`  RCON ← ${text}`);
      done(null, text);
    });

    const req = makePacket('challenge rcon');
    sock.send(req, 0, req.length, port, host);
  });
}

/**
 * Sends the deploy.rcon.command with {plugin} interpolated.
 * No-ops silently if RCON is not configured.
 */
async function sendRconCommand(deployConfig, pluginName) {
  const { host, port, password, command } = deployConfig.rcon;
  if (!command || !host || !password) return;

  const cmd = command.replace(/\{plugin\}/g, pluginName);
  logger.step(`RCON → ${cmd}`);
  try {
    const response = await sendRcon({ host, port, password, command: cmd });
    if (response) logger.dim(`  RCON response: ${response}`);
  } catch (err) {
    logger.warn(`RCON failed: ${err.message}`);
  }
}

/**
 * Sends RCON after deploying one or more plugins.
 * If the command contains {plugin} — sends once per plugin name.
 * Otherwise — sends the command once regardless of how many plugins were deployed.
 */
async function sendRconForPlugins(deployConfig, pluginNames) {
  const command = deployConfig.rcon && deployConfig.rcon.command;
  if (!command) return;

  if (command.includes('{plugin}')) {
    for (const name of pluginNames) {
      await sendRconCommand(deployConfig, name);
    }
  } else {
    await sendRconCommand(deployConfig, '');
  }
}

module.exports = { sendRcon, sendRconCommand, sendRconForPlugins };
