'use strict';
// A worker receives only the already selected project and bounded operations.
// It cannot read native Codex threads or credentials and accepts no file path.
const { parentPort, workerData } = require('node:worker_threads');
const { ChatHistory } = require('./chat-history.cjs');
const { MemoryStore } = require('./chat-memory.cjs');
const measure = value => Buffer.byteLength(value);
const memory = workerData.hasMemory ? new MemoryStore({ projectRoot: workerData.projectRoot, countTokens: measure }) : null;
const history = new ChatHistory({ projectRoot: workerData.projectRoot, memory, measure, worker: false, semanticOptions: workerData.semanticOptions });
let sequence = Promise.resolve(), cancelled = false, closing = false;
parentPort.on('message', message => {
  if (message.method === 'close') {
    closing = true; cancelled = true;
    sequence = sequence.then(async () => { await history.close(); clearInterval(healthTimer); parentPort.postMessage({ id: message.id, closed: true }); parentPort.close(); });
    return;
  }
  if (message.cancel === true) { cancelled = true; return; }
  sequence = sequence.then(async () => {
    let result, error;
    try {
      if (closing) throw Object.assign(new Error('CHAT_HISTORY_CLOSED'), { code: 'CHAT_HISTORY_CLOSED' });
      if (['rebuildIndex', 'syncIndex', 'updateIndex'].includes(message.method)) { cancelled = false; result = await history[message.method]({ ...message.args, isCancelled: () => cancelled }); }
      else if (['searchRecords', 'readRecords'].includes(message.method)) result = await history[message.method](message.args.input, history.beginTurn({ availableTokens: message.args.availableTokens }));
      else throw new Error('CHAT_HISTORY_WORKER_METHOD');
    } catch (failure) { error = /^[A-Z][A-Z_]+$/.test(failure.code || failure.message) ? failure.code || failure.message : 'CHAT_HISTORY_WORKER_FAILED'; }
    parentPort.postMessage({ id: message.id, health: history.health(), ...(error ? { error } : { result }) });
  });
});
const healthTimer = setInterval(() => parentPort.postMessage({ health: history.health() }), 1000); healthTimer.unref();
