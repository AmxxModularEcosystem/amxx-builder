'use strict';

/**
 * Optional MCP tools that drive a live AMX Mod X server through the
 * amxx-rpc-module (JSON-RPC 2.0 over TCP).
 *
 * This module is pure glue over the core client (src/rpc-client.js) and config
 * resolver (src/rpc-config.js): it owns the client singleton, the notification
 * buffer, the subscription set, and the tool schemas/handlers. No protocol
 * implementation lives here.
 *
 * The tools are opt-in: they are only advertised/callable when
 * resolveRpcConfig().enabled is true (a non-empty AMXB_RPC_TOKEN and
 * AMXB_RPC_ENABLED not falsy).
 */

const { RpcClient, RpcError } = require('../src/rpc-client');
const { resolveRpcConfig } = require('../src/rpc-config');
const { textResult, errorResult, applyOutputLimit } = require('./tool-result');

const MAX_BUFFERED_NOTIFICATIONS = 500;

// ─── Client singleton + notification buffer ────────────────────────────────────

let _client = null;
let _clientKey = null;
const _notifications = [];
const _subscribed = new Set();

function isRpcConfigured() {
  return resolveRpcConfig().enabled;
}

function getClient() {
  const cfg = resolveRpcConfig();
  if (!cfg.enabled) {
    throw new RpcError(-32001, 'RPC not configured: ' + (cfg.reason || 'missing token'));
  }

  const key = `${cfg.host}:${cfg.port}:${cfg.token}`;
  if (_client && _clientKey === key) return _client;

  if (_client) {
    try { _client.close(); } catch (_) { /* already torn down */ }
    // A different endpoint/token: drop state that belonged to the old server.
    _notifications.length = 0;
    _subscribed.clear();
  }

  const client = new RpcClient(cfg);

  client.on('notification', (method, params) => {
    _notifications.push({ event: method, params });
    if (_notifications.length > MAX_BUFFERED_NOTIFICATIONS) _notifications.shift();
  });

  // Re-subscribe every known event after a (re)connect. Best-effort: a failed
  // re-subscribe must never crash the client or the tool call.
  client.on('connected', () => {
    for (const event of _subscribed) {
      client.call('events.subscribe', { event }).catch(() => {});
    }
  });

  _client = client;
  _clientKey = key;
  return client;
}

function __resetForTests() {
  if (_client) {
    try { _client.close(); } catch (_) { /* already torn down */ }
  }
  _client = null;
  _clientKey = null;
  _notifications.length = 0;
  _subscribed.clear();
}

// ─── Result helpers ────────────────────────────────────────────────────────────

function missing(name) {
  return errorResult(`Missing required "${name}" parameter`, -32602);
}

function rpcErrorResult(err) {
  if (err instanceof RpcError) {
    let text = err.message;
    if (err.data !== undefined) text += ' ' + JSON.stringify(err.data);
    return errorResult(text, err.code);
  }
  return errorResult(err.message);
}

async function rpcCall(method, params, args) {
  try {
    const result = await getClient().call(method, params);
    return textResult(applyOutputLimit(JSON.stringify(result ?? null, null, 2), args));
  } catch (err) {
    return rpcErrorResult(err);
  }
}

// Attach only the keys that are present — never send `undefined` over the wire.
function pick(args, keys) {
  const out = {};
  for (const key of keys) {
    if (args && args[key] !== undefined) out[key] = args[key];
  }
  return out;
}

// ─── Handlers ──────────────────────────────────────────────────────────────────

async function handleRpcCall(args) {
  if (typeof args?.method !== 'string' || !args.method) return missing('method');
  const params = args.params === undefined ? {} : args.params;
  return rpcCall(args.method, params, args);
}

async function handleRpcStatus(args) {
  try {
    const client = getClient();
    const [version, ping] = await Promise.all([
      client.call('rpc.version', {}),
      client.call('rpc.ping', {}),
    ]);
    return textResult(applyOutputLimit(JSON.stringify({ version, ping }, null, 2), args));
  } catch (err) {
    return rpcErrorResult(err);
  }
}

async function handleRpcMethods(args) {
  try {
    let result = await getClient().call('rpc.methods', {});
    if (args?.grep) {
      const needle = String(args.grep).toLowerCase();
      const nameOf = (m) => (typeof m === 'string' ? m : (m && (m.name || m.method)));
      const matches = (m) => {
        const name = nameOf(m);
        return typeof name === 'string' && name.toLowerCase().includes(needle);
      };
      if (Array.isArray(result)) {
        result = result.filter(matches);
      } else if (result && Array.isArray(result.methods)) {
        result = { ...result, methods: result.methods.filter(matches) };
      }
    }
    return textResult(applyOutputLimit(JSON.stringify(result, null, 2), args));
  } catch (err) {
    return rpcErrorResult(err);
  }
}

async function handleServerExec(args) {
  if (typeof args?.command !== 'string' || !args.command) return missing('command');
  return rpcCall('server.exec', { command: args.command }, args);
}

async function handleCvarGet(args) {
  if (typeof args?.name !== 'string' || !args.name) return missing('name');
  return rpcCall('cvar.get', { name: args.name }, args);
}

async function handleCvarSet(args) {
  if (typeof args?.name !== 'string' || !args.name) return missing('name');
  if (args.value === undefined) return missing('value');
  return rpcCall('cvar.set', { name: args.name, value: args.value }, args);
}

async function handlePlayersList(args) {
  return rpcCall('players.list', {}, args);
}

async function handlePlayerGet(args) {
  if (typeof args?.index !== 'number') return missing('index');
  return rpcCall('players.get', { index: args.index }, args);
}

async function handleEventsSubscribe(args) {
  if (typeof args?.event !== 'string' || !args.event) return missing('event');
  // Subscribe before remembering the event: the 'connected' re-subscribe pass
  // would otherwise fire a duplicate while this first subscribe is in flight.
  const result = await rpcCall('events.subscribe', { event: args.event }, args);
  if (!result.isError) _subscribed.add(args.event);
  return result;
}

async function handleEventsUnsubscribe(args) {
  if (typeof args?.event !== 'string' || !args.event) return missing('event');
  _subscribed.delete(args.event);
  return rpcCall('events.unsubscribe', { event: args.event }, args);
}

async function handleEventsDrain(args) {
  const limit = args?.limit;
  const take =
    Number.isInteger(limit) && limit > 0
      ? Math.min(limit, _notifications.length)
      : _notifications.length;
  const events = _notifications.slice(0, take);
  // Clear only what was actually returned — never drop unread events.
  if (args?.clear !== false) _notifications.splice(0, take);
  return textResult(applyOutputLimit(JSON.stringify({ count: events.length, events }, null, 2), args));
}

async function handleFakeCreate(args) {
  if (typeof args?.name !== 'string' || !args.name) return missing('name');
  return rpcCall('fake.create', { name: args.name, ...pick(args, ['authid', 'team']) }, args);
}

async function handleFakeRemove(args) {
  if (typeof args?.index !== 'number') return missing('index');
  return rpcCall('fake.remove', { index: args.index }, args);
}

async function handleFakeList(args) {
  return rpcCall('fake.list', {}, args);
}

async function handleFakeGet(args) {
  if (typeof args?.index !== 'number') return missing('index');
  return rpcCall('fake.get', { index: args.index }, args);
}

async function handleFakeMove(args) {
  if (typeof args?.index !== 'number') return missing('index');
  return rpcCall('fake.move', { index: args.index, ...pick(args, ['forward', 'side', 'up']) }, args);
}

async function handleFakeLook(args) {
  if (typeof args?.index !== 'number') return missing('index');
  if (args.angles === undefined && args.at === undefined) {
    return errorResult('Missing required "angles" or "at" parameter', -32602);
  }
  return rpcCall('fake.look', { index: args.index, ...pick(args, ['angles', 'at']) }, args);
}

async function handleFakeStop(args) {
  if (typeof args?.index !== 'number') return missing('index');
  return rpcCall('fake.stop', { index: args.index }, args);
}

async function handleFakeButtons(args) {
  if (typeof args?.index !== 'number') return missing('index');
  return rpcCall('fake.buttons', { index: args.index, ...pick(args, ['press', 'release']) }, args);
}

async function handleFakeSet(args) {
  if (typeof args?.index !== 'number') return missing('index');
  return rpcCall('fake.set', { index: args.index, ...pick(args, ['health', 'armor', 'team', 'weapon']) }, args);
}

async function handleFakeAuthid(args) {
  if (typeof args?.index !== 'number') return missing('index');
  return rpcCall('fake.authid', { index: args.index, ...pick(args, ['authid']) }, args);
}

async function handleBotAvailable(args) {
  return rpcCall('bot.available', {}, args);
}

async function handleBotAdd(args) {
  if (typeof args?.name !== 'string' || !args.name) return missing('name');
  return rpcCall('bot.add', { name: args.name, ...pick(args, ['difficulty', 'personality', 'team']) }, args);
}

async function handleBotList(args) {
  return rpcCall('bot.list', {}, args);
}

async function handleBotGoal(args) {
  if (typeof args?.index !== 'number') return missing('index');
  return rpcCall('bot.goal', { index: args.index, ...pick(args, ['origin', 'node']) }, args);
}

async function handleBotLook(args) {
  if (typeof args?.index !== 'number') return missing('index');
  if (args.origin === undefined) return missing('origin');
  return rpcCall('bot.look', { index: args.index, origin: args.origin }, args);
}

async function handleBotFreeze(args) {
  if (typeof args?.index !== 'number') return missing('index');
  if (typeof args?.frozen !== 'boolean') return missing('frozen');
  return rpcCall('bot.freeze', { index: args.index, frozen: args.frozen }, args);
}

async function handleBotStatus(args) {
  if (typeof args?.index !== 'number') return missing('index');
  return rpcCall('bot.status', { index: args.index }, args);
}

// ─── Tool definitions ──────────────────────────────────────────────────────────

const RPC_TOOLS = [
  {
    name: 'rpc_call',
    title: 'Вызвать произвольный RPC-метод',
    description:
      'Вызывает произвольный RPC-метод и возвращает сырой result (произвольный метод). ' +
      'Запасной путь для методов Pawn-плагинов и будущих методов.',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', description: 'Имя RPC-метода' },
        params: { type: 'object', description: 'Параметры метода (по умолчанию {})', default: {} },
      },
      required: ['method'],
    },
    optional: true,
    group: 'rpc',
  },
  {
    name: 'rpc_status',
    title: 'Статус RPC-модуля',
    description: 'Возвращает версию и пинг RPC-модуля (rpc.version + rpc.ping).',
    inputSchema: { type: 'object', properties: {} },
    optional: true,
    group: 'rpc',
  },
  {
    name: 'rpc_methods',
    title: 'Каталог RPC-методов',
    description: 'Возвращает каталог зарегистрированных RPC-методов (rpc.methods).',
    inputSchema: {
      type: 'object',
      properties: {
        grep: { type: 'string', description: 'Фильтр по подстроке имени метода (без учёта регистра)' },
      },
    },
    optional: true,
    group: 'rpc',
  },
  {
    name: 'server_exec',
    title: 'Выполнить команду сервера',
    description: 'Выполняет консольную команду сервера (server.exec). Вывод не захватывается.',
    inputSchema: {
      type: 'object',
      properties: { command: { type: 'string', description: 'Консольная команда' } },
      required: ['command'],
    },
    optional: true,
    group: 'rpc',
  },
  {
    name: 'cvar_get',
    title: 'Прочитать cvar',
    description: 'Читает значение cvar (cvar.get).',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Имя cvar' } },
      required: ['name'],
    },
    optional: true,
    group: 'rpc',
  },
  {
    name: 'cvar_set',
    title: 'Установить cvar',
    description: 'Устанавливает значение cvar (cvar.set).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Имя cvar' },
        value: { type: 'string', description: 'Новое значение' },
      },
      required: ['name', 'value'],
    },
    optional: true,
    group: 'rpc',
  },
  {
    name: 'players_list',
    title: 'Список игроков',
    description: 'Возвращает список игроков (players.list).',
    inputSchema: { type: 'object', properties: {} },
    optional: true,
    group: 'rpc',
  },
  {
    name: 'player_get',
    title: 'Данные игрока',
    description: 'Возвращает данные одного игрока (players.get).',
    inputSchema: {
      type: 'object',
      properties: { index: { type: 'number', description: 'Индекс игрока' } },
      required: ['index'],
    },
    optional: true,
    group: 'rpc',
  },
  {
    name: 'events_subscribe',
    title: 'Подписаться на событие',
    description: 'Подписывает на серверное событие (events.subscribe). Подписки восстанавливаются после переподключения.',
    inputSchema: {
      type: 'object',
      properties: { event: { type: 'string', description: 'Имя события' } },
      required: ['event'],
    },
    optional: true,
    group: 'rpc',
  },
  {
    name: 'events_unsubscribe',
    title: 'Отписаться от события',
    description: 'Отписывает от серверного события (events.unsubscribe).',
    inputSchema: {
      type: 'object',
      properties: { event: { type: 'string', description: 'Имя события' } },
      required: ['event'],
    },
    optional: true,
    group: 'rpc',
  },
  {
    name: 'events_drain',
    title: 'Забрать буфер событий',
    description: 'Возвращает буферизованные уведомления сервера (локальный буфер).',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Максимум уведомлений за вызов' },
        clear: { type: 'boolean', description: 'Очистить буфер после чтения', default: true },
      },
    },
    optional: true,
    group: 'rpc',
  },
  {
    name: 'fake_create',
    title: 'Создать фейк-игрока',
    description: 'Создаёт фейк-игрока (fake.create).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Имя фейк-игрока' },
        authid: { type: 'string', description: 'Authid, например STEAM_1:0:1' },
        team: { type: 'number', description: 'Номер команды' },
      },
      required: ['name'],
    },
    optional: true,
    group: 'rpc',
  },
  {
    name: 'fake_remove',
    title: 'Удалить фейк-игрока',
    description: 'Удаляет фейк-игрока (fake.remove).',
    inputSchema: {
      type: 'object',
      properties: { index: { type: 'number', description: 'Индекс фейк-игрока' } },
      required: ['index'],
    },
    optional: true,
    group: 'rpc',
  },
  {
    name: 'fake_list',
    title: 'Список фейк-игроков',
    description: 'Возвращает список фейк-игроков (fake.list).',
    inputSchema: { type: 'object', properties: {} },
    optional: true,
    group: 'rpc',
  },
  {
    name: 'fake_get',
    title: 'Данные фейк-игрока',
    description: 'Возвращает данные фейк-игрока (fake.get).',
    inputSchema: {
      type: 'object',
      properties: { index: { type: 'number', description: 'Индекс фейк-игрока' } },
      required: ['index'],
    },
    optional: true,
    group: 'rpc',
  },
  {
    name: 'fake_move',
    title: 'Двигать фейк-игрока',
    description: 'Двигает фейк-игрока по осям (fake.move).',
    inputSchema: {
      type: 'object',
      properties: {
        index: { type: 'number', description: 'Индекс фейк-игрока' },
        forward: { type: 'number', description: 'Смещение вперёд' },
        side: { type: 'number', description: 'Смещение в сторону' },
        up: { type: 'number', description: 'Смещение вверх' },
      },
      required: ['index'],
    },
    optional: true,
    group: 'rpc',
  },
  {
    name: 'fake_look',
    title: 'Направить взгляд фейк-игрока',
    description: 'Задаёт направление взгляда фейк-игрока углами или точкой (fake.look).',
    inputSchema: {
      type: 'object',
      properties: {
        index: { type: 'number', description: 'Индекс фейк-игрока' },
        angles: { type: 'array', items: { type: 'number' }, description: 'Углы [pitch, yaw, roll]' },
        at: { type: 'array', items: { type: 'number' }, description: 'Точка [x, y, z], куда смотреть' },
      },
      required: ['index'],
      anyOf: [{ required: ['angles'] }, { required: ['at'] }],
    },
    optional: true,
    group: 'rpc',
  },
  {
    name: 'fake_stop',
    title: 'Остановить фейк-игрока',
    description: 'Останавливает движение фейк-игрока (fake.stop).',
    inputSchema: {
      type: 'object',
      properties: { index: { type: 'number', description: 'Индекс фейк-игрока' } },
      required: ['index'],
    },
    optional: true,
    group: 'rpc',
  },
  {
    name: 'fake_buttons',
    title: 'Кнопки фейк-игрока',
    description: 'Нажимает и/или отпускает кнопки фейк-игрока (fake.buttons).',
    inputSchema: {
      type: 'object',
      properties: {
        index: { type: 'number', description: 'Индекс фейк-игрока' },
        press: {
          type: 'array',
          items: { oneOf: [{ type: 'string' }, { type: 'number' }] },
          description: 'Кнопки нажать: имена (IN_ATTACK, IN_JUMP) или числа',
        },
        release: {
          type: 'array',
          items: { oneOf: [{ type: 'string' }, { type: 'number' }] },
          description: 'Кнопки отпустить: имена или числа',
        },
      },
      required: ['index'],
    },
    optional: true,
    group: 'rpc',
  },
  {
    name: 'fake_set',
    title: 'Изменить состояние фейк-игрока',
    description: 'Меняет состояние фейк-игрока (fake.set).',
    inputSchema: {
      type: 'object',
      properties: {
        index: { type: 'number', description: 'Индекс фейк-игрока' },
        health: { type: 'number', description: 'Здоровье' },
        armor: { type: 'number', description: 'Броня' },
        team: { type: 'number', description: 'Номер команды' },
        weapon: { type: 'string', description: 'Оружие' },
      },
      required: ['index'],
    },
    optional: true,
    group: 'rpc',
  },
  {
    name: 'fake_authid',
    title: 'Задать authid фейк-игрока',
    description: 'Задаёт authid фейк-игрока (fake.authid).',
    inputSchema: {
      type: 'object',
      properties: {
        index: { type: 'number', description: 'Индекс фейк-игрока' },
        authid: { type: 'string', description: 'Новый authid' },
      },
      required: ['index'],
    },
    optional: true,
    group: 'rpc',
  },
  {
    name: 'bot_available',
    title: 'Доступность ботов YAPB',
    description: 'Проверяет, доступны ли боты YAPB (bot.available).',
    inputSchema: { type: 'object', properties: {} },
    optional: true,
    group: 'rpc',
  },
  {
    name: 'bot_add',
    title: 'Добавить бота',
    description: 'Добавляет бота (bot.add).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Имя бота' },
        difficulty: { type: 'number', description: 'Сложность' },
        personality: { type: 'string', description: 'Характер' },
        team: { type: 'number', description: 'Номер команды' },
      },
      required: ['name'],
    },
    optional: true,
    group: 'rpc',
  },
  {
    name: 'bot_list',
    title: 'Список ботов',
    description: 'Возвращает список ботов (bot.list).',
    inputSchema: { type: 'object', properties: {} },
    optional: true,
    group: 'rpc',
  },
  {
    name: 'bot_goal',
    title: 'Задать цель бота',
    description: 'Задаёт цель бота (bot.goal).',
    inputSchema: {
      type: 'object',
      properties: {
        index: { type: 'number', description: 'Индекс бота' },
        origin: { type: 'array', items: { type: 'number' }, description: 'Точка [x, y, z]' },
        node: { type: 'number', description: 'Номер узла навигации' },
      },
      required: ['index'],
    },
    optional: true,
    group: 'rpc',
  },
  {
    name: 'bot_look',
    title: 'Направить взгляд бота',
    description: 'Заставляет бота смотреть в точку (bot.look).',
    inputSchema: {
      type: 'object',
      properties: {
        index: { type: 'number', description: 'Индекс бота' },
        origin: { type: 'array', items: { type: 'number' }, description: 'Точка [x, y, z]' },
      },
      required: ['index', 'origin'],
    },
    optional: true,
    group: 'rpc',
  },
  {
    name: 'bot_freeze',
    title: 'Заморозить/разморозить бота',
    description: 'Заморозить или разморозить бота (bot.freeze).',
    inputSchema: {
      type: 'object',
      properties: {
        index: { type: 'number', description: 'Индекс бота' },
        frozen: { type: 'boolean', description: 'true заморозить, false разморозить' },
      },
      required: ['index', 'frozen'],
    },
    optional: true,
    group: 'rpc',
  },
  {
    name: 'bot_status',
    title: 'Состояние бота',
    description: 'Возвращает состояние бота (bot.status).',
    inputSchema: {
      type: 'object',
      properties: { index: { type: 'number', description: 'Индекс бота' } },
      required: ['index'],
    },
    optional: true,
    group: 'rpc',
  },
];

const RPC_HANDLERS = {
  rpc_call: handleRpcCall,
  rpc_status: handleRpcStatus,
  rpc_methods: handleRpcMethods,
  server_exec: handleServerExec,
  cvar_get: handleCvarGet,
  cvar_set: handleCvarSet,
  players_list: handlePlayersList,
  player_get: handlePlayerGet,
  events_subscribe: handleEventsSubscribe,
  events_unsubscribe: handleEventsUnsubscribe,
  events_drain: handleEventsDrain,
  fake_create: handleFakeCreate,
  fake_remove: handleFakeRemove,
  fake_list: handleFakeList,
  fake_get: handleFakeGet,
  fake_move: handleFakeMove,
  fake_look: handleFakeLook,
  fake_stop: handleFakeStop,
  fake_buttons: handleFakeButtons,
  fake_set: handleFakeSet,
  fake_authid: handleFakeAuthid,
  bot_available: handleBotAvailable,
  bot_add: handleBotAdd,
  bot_list: handleBotList,
  bot_goal: handleBotGoal,
  bot_look: handleBotLook,
  bot_freeze: handleBotFreeze,
  bot_status: handleBotStatus,
};

module.exports = { RPC_TOOLS, RPC_HANDLERS, isRpcConfigured, __resetForTests };