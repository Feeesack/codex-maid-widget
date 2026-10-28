'use strict';

// Only checkpoint commits persist conversation bodies. Runtime display and
// lifecycle recovery use separate memory/metadata surfaces and cannot append.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { resumeChatProject, checkedDirectory } = require('./chat-project.cjs');

const SCHEMA = 'codex-maid-chat/1';
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const ID = /^[A-Za-z0-9_.:-]{1,256}$/;
const MAX_READ_BYTES = 64 * 1024 * 1024;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (code, message) => Object.assign(new Error(message), { code });

function identifier(value, label, pattern = ID) {
  if (typeof value !== 'string' || !pattern.test(value)) throw fail('CHAT_ARCHIVE_INVALID', `Invalid ${label}.`);
  return value;
}

function time(value, nullable = true) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw fail('CHAT_ARCHIVE_INVALID', 'Expected an ISO timestamp with an explicit offset, or null.');
  }
  return value;
}

function localStart(startedAt, timezone) {
  time(startedAt, false);
  if (typeof timezone !== 'string' || !timezone || timezone.length > 100) throw fail('CHAT_ARCHIVE_INVALID', 'An explicit valid time zone is required.');
  let parts;
  try {
    parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(startedAt)).map(part => [part.type, part.value]));
  } catch { throw fail('CHAT_ARCHIVE_INVALID', 'Unsupported time zone.'); }
  return { archiveDate: `${parts.year}-${parts.month}-${parts.day}`, title: `${parts.year}-${parts.month}-${parts.day}_${parts.hour}-${parts.minute}-${parts.second}` };
}

function safeFile(file, io = fs, maximum = MAX_READ_BYTES) {
  const info = io.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) throw fail('CHAT_ARCHIVE_UNSAFE', 'Archive resource is linked, invalid or exceeds this read budget.');
  return info;
}

function childDirectory(root, parts, io = fs, create = false) {
  let current = checkedDirectory(root, io);
  for (const part of parts) {
    if (typeof part !== 'string' || !part || part === '.' || part === '..' || /[\\/\0]/.test(part)) throw fail('CHAT_ARCHIVE_UNSAFE', 'Unsafe project-relative directory.');
    current = path.join(current, part);
    try { io.lstatSync(current); }
    catch (error) { if (error.code !== 'ENOENT' || !create) throw error; io.mkdirSync(current); }
    const info = io.lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink() || io.realpathSync(current) !== current) throw fail('CHAT_ARCHIVE_UNSAFE', 'Archive directories must not escape through links.');
  }
  return current;
}

function createConversation({ root, startedAt, timezone, nativeThreadId, conversationId = `C-${randomUUID()}`, titleSuffix = 0,
  messageTimeSource = 'unknown', fs: io = fs } = {}) {
  const local = localStart(startedAt, timezone);
  identifier(conversationId, 'conversation ID', /^C-[A-Za-z0-9-]{1,128}$/);
  if (nativeThreadId !== undefined) identifier(nativeThreadId, 'native thread ID');
  if (!Number.isSafeInteger(titleSuffix) || titleSuffix < 0 || titleSuffix > 999999) throw fail('CHAT_ARCHIVE_INVALID', 'Invalid title suffix.');
  let suffix = titleSuffix;
  if (root) {
    const initialized = resumeChatProject(root, { fs: io });
    let directory;
    try { directory = childDirectory(initialized.root, ['chat-history', local.archiveDate], io); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    while (directory && io.existsSync(path.join(directory, `${local.title}${suffix ? `-${suffix}` : ''}.jsonl`))) suffix++;
  }
  const result = { conversationId, startedAt, archiveDate: local.archiveDate, timezone,
    title: `${local.title}${suffix ? `-${suffix}` : ''}`, messageTimeSource };
  if (nativeThreadId !== undefined) result.nativeThreadId = nativeThreadId;
  return validateConversation(result);
}

function validateConversation(value) {
  if (!value || typeof value !== 'object') throw fail('CHAT_ARCHIVE_INVALID', 'Missing conversation metadata.');
  const start = localStart(value.startedAt, value.timezone);
  identifier(value.conversationId, 'conversation ID', /^C-[A-Za-z0-9-]{1,128}$/);
  if (value.archiveDate !== start.archiveDate || typeof value.title !== 'string' ||
      !new RegExp(`^${start.title}(?:-[1-9]\\d{0,5})?$`).test(value.title)) throw fail('CHAT_ARCHIVE_INVALID', 'The archive date/title must remain bound to the conversation start.');
  if (!['unknown', 'native_event', 'native_history', 'client_observed_at', 'source_log'].includes(value.messageTimeSource)) throw fail('CHAT_ARCHIVE_INVALID', 'Invalid message time provenance.');
  const result = { conversationId: value.conversationId, startedAt: value.startedAt, archiveDate: value.archiveDate,
    timezone: value.timezone, title: value.title, messageTimeSource: value.messageTimeSource };
  if (value.nativeThreadId !== undefined) result.nativeThreadId = identifier(value.nativeThreadId, 'native thread ID');
  return result;
}

function numbers(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('CHAT_ARCHIVE_INVALID', 'Invalid token usage.');
  const result = {};
  for (const key of ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens']) {
    if (!own(value, key)) continue;
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) throw fail('CHAT_ARCHIVE_INVALID', 'Token usage must be a known nonnegative integer.');
    result[key] = value[key];
  }
  return result;
}

function versionMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('CHAT_ARCHIVE_INVALID', 'Invalid loaded version map.');
  const result = {};
  for (const [key, version] of Object.entries(value)) {
    if (!['persona', 'recent', 'userView', 'facts', 'root', 'sourceWatermark', 'operationWatermark'].includes(key) ||
      !(version === null || Number.isSafeInteger(version) && version >= 0 || typeof version === 'string' && ID.test(version))) throw fail('CHAT_ARCHIVE_INVALID', 'Invalid loaded version metadata.');
    result[key] = version;
  }
  return result;
}

function imageFormat(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return ['image/png', 'png'];
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return ['image/jpeg', 'jpg'];
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return ['image/gif', 'gif'];
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return ['image/webp', 'webp'];
  throw fail('CHAT_IMAGE_UNVERIFIED', 'The image media type could not be verified from its original bytes.');
}

function normalizeRecords(records, conversation) {
  if (!Array.isArray(records) || !records.length) throw fail('CHAT_ARCHIVE_INVALID', 'A checkpoint must contain complete allowed source records.');
  const terminal = new Map();
  for (const record of records) if (record?.turn_result) {
    const result = record.turn_result;
    identifier(result.id, 'turn ID', /^T\d+$/);
    if (!TERMINAL.has(result.status)) throw fail('CHAT_TERMINAL_UNCONFIRMED', 'An unknown execution state cannot be archived as a completed checkpoint.');
    if (terminal.has(result.id)) throw fail('CHAT_ARCHIVE_INVALID', 'Duplicate turn result.');
    terminal.set(result.id, result.status);
  }
  const output = [], images = [], turns = new Set(), finished = new Set(), messages = new Map();
  for (const record of records) {
    if (!record || typeof record !== 'object') throw fail('CHAT_ARCHIVE_INVALID', 'Invalid source record.');
    if (record.turn) {
      const input = record.turn, id = identifier(input.id, 'turn ID', /^T\d+$/);
      if (turns.has(id) || !terminal.has(id)) throw fail('CHAT_TERMINAL_UNCONFIRMED', 'Each real turn must have one reliable terminal result.');
      turns.add(id);
      const turn = { id, observed_at: time(input.observed_at ?? null) };
      if (own(input, 'native_turn_id')) turn.native_turn_id = identifier(input.native_turn_id, 'native turn ID');
      if (own(input, 'requested_model')) turn.requested_model = input.requested_model === null ? null : identifier(input.requested_model, 'model');
      if (own(input, 'persona_version')) {
        if (input.persona_version !== null && (!Number.isSafeInteger(input.persona_version) || input.persona_version < 0)) throw fail('CHAT_ARCHIVE_INVALID', 'Invalid actual persona version.');
        turn.persona_version = input.persona_version;
      }
      if (own(input, 'memory_view_versions')) turn.memory_view_versions = versionMap(input.memory_view_versions);
      output.push({ turn }); continue;
    }
    if (record.turn_result) {
      const input = record.turn_result, id = input.id;
      if (!turns.has(id) || finished.has(id)) throw fail('CHAT_ARCHIVE_INVALID', 'Turn result has no unique preceding turn.');
      finished.add(id);
      const result = { id, observed_at: time(input.observed_at ?? null), status: input.status };
      for (const key of ['actual_model', 'source_event']) if (own(input, key)) result[key] = input[key] === null ? null : identifier(input[key], key);
      for (const key of ['usage', 'cumulative_usage']) if (own(input, key)) result[key] = numbers(input[key]);
      output.push({ turn_result: result }); continue;
    }
    if (!['user', 'assistant'].includes(record.role)) throw fail('CHAT_ARCHIVE_FORBIDDEN', 'Only user messages and allowed assistant answers can enter the archive.');
    const id = identifier(record.id, 'message ID', /^M\d+$/);
    if (messages.has(id)) throw fail('CHAT_ARCHIVE_INVALID', 'Message IDs cannot be reused.');
    const turnId = record.turn_id === null ? null : identifier(record.turn_id, 'message turn ID', /^T\d+$/);
    if (turnId !== null && (!turns.has(turnId) || finished.has(turnId))) throw fail('CHAT_ARCHIVE_INVALID', 'Message order or real turn association is invalid.');
    messages.set(id, record.role);
    if (record.role === 'assistant') {
      const status = turnId === null ? record.status : terminal.get(turnId);
      if (![null, 'final_answer', 'partial_answer', 'commentary'].includes(record.phase ?? null)) throw fail('CHAT_PHASE_UNCONFIRMED', 'An unrecognized assistant phase cannot be guessed as a final answer.');
      if (!TERMINAL.has(status)) throw fail('CHAT_TERMINAL_UNCONFIRMED', 'The answer terminal state is not confirmed.');
      if (status === 'completed' && record.phase === 'commentary') continue;
      if (status === 'completed' && record.phase !== 'final_answer') throw fail('CHAT_PHASE_UNCONFIRMED', 'A completed turn needs a verified final answer.');
      if (status !== 'completed' && record.displayed !== true) throw fail('CHAT_PARTIAL_UNCONFIRMED', 'Failure/interruption fragments must have been actually displayed.');
    }
    if (!Array.isArray(record.content)) throw fail('CHAT_ARCHIVE_INVALID', 'Message content must retain its ordered parts.');
    const message = { id, turn_id: turnId, time: time(record.time ?? null), role: record.role };
    if (own(record, 'native_message_id')) message.native_message_id = identifier(record.native_message_id, 'native message ID');
    if (record.role === 'assistant') message.phase = record.phase ?? null;
    if (own(record, 'append_to')) {
      if (record.role !== 'user') throw fail('CHAT_ARCHIVE_INVALID', 'Only a real user append operation can have append_to.');
      if (record.append_to !== null && (messages.get(record.append_to) !== 'user' || record.append_to === id)) throw fail('CHAT_ARCHIVE_INVALID', 'Append target must be an earlier known user message.');
      message.append_to = record.append_to;
    }
    if (own(record, 'delivery')) message.delivery = identifier(record.delivery, 'delivery mode');
    if (own(record, 'status')) {
      if (![...TERMINAL, 'unknown'].includes(record.status)) throw fail('CHAT_ARCHIVE_INVALID', 'Invalid observed message status.');
      message.status = record.status;
    }
    let imageNumber = 0;
    message.content = record.content.map(part => {
      if (typeof part?.text === 'string' && Object.keys(part).length === 1) return { text: part.text };
      if (!part?.image || Object.keys(part).length !== 1) throw fail('CHAT_ARCHIVE_FORBIDDEN', 'Unrecognized content cannot be written as conversation text.');
      const image = part.image;
      if (!Buffer.isBuffer(image.bytes) && !(image.bytes instanceof Uint8Array)) throw fail('CHAT_IMAGE_UNAVAILABLE', 'Original image bytes are required before a checkpoint can commit.');
      const bytes = Buffer.from(image.bytes), [mime, extension] = imageFormat(bytes), sha256 = hash(bytes);
      if (image.mime !== undefined && image.mime !== null && image.mime !== mime || image.sha256 !== undefined && image.sha256 !== sha256 ||
          image.size !== undefined && image.size !== bytes.length) throw fail('CHAT_IMAGE_MISMATCH', 'Image bytes do not match their verified source metadata.');
      if (image.name !== undefined && image.name !== null && (typeof image.name !== 'string' || image.name.length > 512 || /[\0\r\n]/.test(image.name))) throw fail('CHAT_ARCHIVE_INVALID', 'Invalid image display name.');
      imageNumber++;
      const relative = path.posix.join('chat-history', conversation.archiveDate, 'attachments', conversation.conversationId, `${id}-${String(imageNumber).padStart(2, '0')}.${extension}`);
      images.push({ relative, bytes, sha256 });
      const value = { path: relative, name: image.name ?? null, mime, size: bytes.length, sha256 };
      if (own(image, 'source')) value.source = identifier(image.source, 'image source');
      return { image: value };
    });
    output.push(message);
  }
  if (turns.size !== finished.size) throw fail('CHAT_TERMINAL_UNCONFIRMED', 'Some source turns have no reliable terminal result.');
  return { records: output, images };
}

function archiveMeta(conversation) {
  const meta = { schema: SCHEMA, conversation_id: conversation.conversationId, started_at: conversation.startedAt,
    archive_date: conversation.archiveDate, timezone: conversation.timezone, message_time_source: conversation.messageTimeSource };
  if (conversation.nativeThreadId !== undefined) meta.native_thread_id = conversation.nativeThreadId;
  return { meta };
}

function readHeader(file, io) {
  safeFile(file, io);
  const descriptor = io.openSync(file, 'r');
  try {
    const bytes = Buffer.alloc(16384), read = io.readSync(descriptor, bytes, 0, bytes.length, 0);
    const end = bytes.subarray(0, read).indexOf(10);
    if (end < 0) throw fail('CHAT_ARCHIVE_INVALID', 'The archive header is missing or exceeds the bounded metadata read.');
    const record = JSON.parse(bytes.subarray(0, end).toString('utf8'));
    if (record?.meta?.schema !== SCHEMA) throw fail('CHAT_ARCHIVE_INVALID', 'Unsupported archive metadata.');
    return record.meta;
  } finally { io.closeSync(descriptor); }
}

function findExisting(root, conversation, io) {
  let history;
  try { history = childDirectory(root, ['chat-history'], io); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let found = null;
  for (const date of io.readdirSync(history)) {
    if (!/^\d{4}-\d\d-\d\d$/.test(date)) continue;
    const directory = childDirectory(root, ['chat-history', date], io);
    for (const name of io.readdirSync(directory)) {
      if (!/^\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d(?:-[1-9]\d{0,5})?\.jsonl$/.test(name)) continue;
      const file = path.join(directory, name), meta = readHeader(file, io);
      if (conversation.nativeThreadId && meta.native_thread_id === conversation.nativeThreadId && meta.conversation_id !== conversation.conversationId) throw fail('CHAT_MAPPING_CONFLICT', 'The native thread already belongs to a different archive conversation.');
      if (meta.conversation_id === conversation.conversationId) {
        if (found) throw fail('CHAT_MAPPING_CONFLICT', 'A conversation has more than one original archive.');
        found = file;
      }
    }
  }
  return found;
}

function writeExclusive(file, data, io) {
  const descriptor = io.openSync(file, 'wx', 0o600);
  try { io.writeFileSync(descriptor, data); io.fsyncSync(descriptor); }
  finally { io.closeSync(descriptor); }
}

function readArchive(root, conversation, { fs: io = fs, maxBytes = MAX_READ_BYTES } = {}) {
  const initialized = resumeChatProject(root, { fs: io }), selected = validateConversation(conversation);
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw fail('CHAT_ARCHIVE_INVALID', 'Invalid archive read budget.');
  const directory = childDirectory(initialized.root, ['chat-history', selected.archiveDate], io);
  const file = path.join(directory, `${selected.title}.jsonl`);
  safeFile(file, io, maxBytes);
  const text = io.readFileSync(file, 'utf8');
  if (!text.endsWith('\n')) throw fail('CHAT_ARCHIVE_INVALID', 'Incomplete JSONL archive.');
  const records = text.slice(0, -1).split('\n').map(line => JSON.parse(line));
  if (JSON.stringify(records[0]) !== JSON.stringify(archiveMeta(selected))) throw fail('CHAT_MAPPING_CONFLICT', 'Archive metadata does not match the selected conversation.');
  return { file, records };
}

function commitCheckpoint({ root, conversation, records, trigger, sourceComplete, fs: io = fs } = {}) {
  if (trigger !== 'new-conversation' || sourceComplete !== true) throw fail('CHAT_CHECKPOINT_REQUIRED', 'Only a new-conversation checkpoint with complete allowed sources may persist chat bodies.');
  const initialized = resumeChatProject(root, { fs: io }), selected = validateConversation(conversation);
  // Complete validation and allowlisting precede every disk write, including
  // temporary files. Raw protocol, reasoning and hidden content never stage.
  const normalized = normalizeRecords(records, selected);
  const all = [archiveMeta(selected), ...normalized.records];
  const text = `${all.map(record => JSON.stringify(record)).join('\n')}\n`;
  const lockFile = path.join(initialized.root, '.chat-archive.lock');
  let lock;
  try { lock = io.openSync(lockFile, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw fail('CHAT_ARCHIVE_BUSY', 'Another archive task or an unreviewed interrupted task holds the project lock.'); throw error; }
  try {
  const existing = findExisting(initialized.root, selected, io);
  const directory = childDirectory(initialized.root, ['chat-history', selected.archiveDate], io, true);
  const file = path.join(directory, `${selected.title}.jsonl`);
  if (existing && existing !== file) throw fail('CHAT_MAPPING_CONFLICT', 'An existing conversation cannot change its original date or filename.');
  if (io.existsSync(file)) {
    const old = readArchive(initialized.root, selected, { fs: io });
    if (old.records.length > all.length || old.records.some((record, index) => JSON.stringify(record) !== JSON.stringify(all[index]))) throw fail('CHAT_ARCHIVE_CONFLICT', 'Committed original records cannot be rewritten, removed or reordered.');
    if (old.records.length === all.length) {
      // Still verify attachments on idempotent reuse; file equality alone is
      // not evidence that original image bytes remain present and intact.
      for (const image of normalized.images) verifyImage(initialized.root, image, io);
      return { file, relativePath: path.relative(initialized.root, file).split(path.sep).join('/'), conversationId: selected.conversationId,
        recordCount: normalized.records.length, complete: true, reused: true, sha256: hash(Buffer.from(text)) };
    }
  }
  for (const image of normalized.images) {
    const parts = image.relative.split('/'), name = parts.pop();
    const attachmentDirectory = childDirectory(initialized.root, parts, io, true), destination = path.join(attachmentDirectory, name);
    if (io.existsSync(destination)) verifyImage(initialized.root, image, io);
    else writeExclusive(destination, image.bytes, io);
    verifyImage(initialized.root, image, io);
  }
  const temporary = path.join(directory, `.${selected.title}-${randomUUID()}.pending.jsonl`);
  writeExclusive(temporary, Buffer.from(text, 'utf8'), io);
  childDirectory(initialized.root, ['chat-history', selected.archiveDate], io);
  if (io.existsSync(file)) safeFile(file, io);
  io.renameSync(temporary, file);
  return { file, relativePath: path.relative(initialized.root, file).split(path.sep).join('/'), conversationId: selected.conversationId,
    recordCount: normalized.records.length, complete: true, reused: false, sha256: hash(Buffer.from(text)) };
  } finally {
    io.closeSync(lock);
    // A crash leaves the lock for explicit recovery, rather than guessing
    // whether an unknown task may safely be repeated.
    io.unlinkSync(lockFile);
  }
}

function verifyImage(root, image, io) {
  const parts = image.relative.split('/'), name = parts.pop();
  const directory = childDirectory(root, parts, io), file = path.join(directory, name);
  const stat = safeFile(file, io, image.bytes.length);
  if (stat.size !== image.bytes.length || hash(io.readFileSync(file)) !== image.sha256) throw fail('CHAT_IMAGE_MISMATCH', 'An archived image is missing or has different original bytes.');
}

const RECOVERY_FIELDS = new Set(['conversationId', 'nativeThreadId', 'nativeTurnId', 'taskId', 'sourceWatermark', 'operationWatermark',
  'lastCommittedCheckpoint', 'executionState', 'startedAt', 'archiveDate', 'timezone', 'title']);

function normalizeRecovery(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('CHAT_RECOVERY_INVALID', 'Invalid recovery metadata.');
  const result = { schema: 'codex-maid-chat-recovery/1' };
  for (const [key, item] of Object.entries(value)) {
    if (!RECOVERY_FIELDS.has(key)) throw fail('CHAT_RECOVERY_INVALID', 'Recovery metadata cannot contain messages, drafts or unrecognized fields.');
    if (item === null) { result[key] = null; continue; }
    if (key === 'startedAt') result[key] = time(item, false);
    else if (key === 'timezone') {
      localStart('2026-01-01T00:00:00Z', item);
      result[key] = item;
    }
    else if (key === 'executionState') {
      if (![...TERMINAL, 'unknown', 'idle', 'running'].includes(item)) throw fail('CHAT_RECOVERY_INVALID', 'Invalid recovery execution state.');
      result[key] = item;
    } else if (['sourceWatermark', 'operationWatermark'].includes(key) && Number.isSafeInteger(item) && item >= 0) result[key] = item;
    else result[key] = identifier(item, key);
  }
  return result;
}

function saveRecoveryMetadata(root, value, { fs: io = fs } = {}) {
  const selected = resumeChatProject(root, { fs: io }), metadata = normalizeRecovery(value);
  const destination = path.join(selected.root, 'chat-recovery.json'), temporary = path.join(selected.root, `.chat-recovery-${randomUUID()}.tmp`);
  if (io.existsSync(destination)) safeFile(destination, io, 16384);
  writeExclusive(temporary, Buffer.from(`${JSON.stringify(metadata)}\n`), io);
  checkedDirectory(selected.root, io);
  if (io.existsSync(destination)) safeFile(destination, io, 16384);
  io.renameSync(temporary, destination);
  return metadata;
}

function readRecoveryMetadata(root, { fs: io = fs } = {}) {
  const selected = resumeChatProject(root, { fs: io }), file = path.join(selected.root, 'chat-recovery.json');
  try {
    safeFile(file, io, 16384);
    const input = JSON.parse(io.readFileSync(file, 'utf8'));
    if (input.schema !== 'codex-maid-chat-recovery/1') throw fail('CHAT_RECOVERY_INVALID', 'Unsupported recovery metadata.');
    const { schema, ...value } = input;
    return normalizeRecovery(value);
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

module.exports = { SCHEMA, createConversation, validateConversation, normalizeRecords, commitCheckpoint, readArchive,
  saveRecoveryMetadata, readRecoveryMetadata };
