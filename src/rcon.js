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
      const body = buf.slice(4).toString('utf8').trim();

      if (body.startsWith('challenge rcon ')) {
        const challenge = body.split(' ')[2];
        const cmd = makePacket(`rcon ${challenge} "${password}" "${command}"`);
        sock.send(cmd, 0, cmd.length, port, host);
        return;
      }

      logger.verbose(`  RCON ← ${body}`);
      done(null, body);
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

module.exports = { sendRcon, sendRconCommand };
