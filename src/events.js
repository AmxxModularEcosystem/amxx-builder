'use strict';

const { EventEmitter } = require('events');

// Module-level shared event bus. All of src/ emits and subscribes through this
// single instance, so interface layers (CLI renderer, MCP, serve/JSON-RPC) can
// observe the same stream of structured events without touching the core.
const bus = new EventEmitter();

// Thin wrappers bound to the shared instance (EventEmitter methods are
// unbound, so they must be bound here to work when destructured).
const on                = bus.on.bind(bus);
const off               = bus.off.bind(bus);
const once              = bus.once.bind(bus);
const emit              = bus.emit.bind(bus);
const removeAllListeners = bus.removeAllListeners.bind(bus);

// Canonical event names for the core render channel.
const EVENTS = {
  LOG:      'log',
  PROGRESS: 'progress',
  STAGE:    'stage',
  COMPILED: 'compiled',
  DIAG:     'diag',
  DONE:     'done',
  ERROR:    'error',
};

module.exports = { on, off, once, emit, removeAllListeners, EVENTS };
