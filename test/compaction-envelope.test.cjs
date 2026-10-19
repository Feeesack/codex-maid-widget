'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

for (const variant of ['', 'macos/']) {
  const { createEnvelope, consumeEnvelope, finishEnvelope } = require(path.join(__dirname, '..', variant, 'src/compaction-envelope.cjs'));
  const name = variant ? 'macOS' : 'Windows';
  function parse(text, chunkSize = 13) {
    const state = createEnvelope(), buffer = Buffer.from(text);
    for (let offset = 0; offset < buffer.length; offset += chunkSize) consumeEnvelope(state, buffer.subarray(offset, offset + chunkSize));
    return { state, result: finishEnvelope(state) };
  }
  test(`${name}: envelope projects only direct payload metadata and supports every byte chunk boundary`, () => {
    const source = JSON.stringify({ type: 'compacted', payload: { replacement_history: [{ content: 'Chinese 中文 and 😀 escaped \\" text' }], message: '', compaction_response_id: 'PRIVATE-RESPONSE-ID' } });
    for (const chunkSize of [1, 2, 3, 7, 17, 128, 10000]) {
      const { state, result } = parse(source, chunkSize);
      assert.deepEqual(result, { valid: true, responseIdPresent: true, responseIdNonempty: true, messageNonempty: false });
      assert.equal(JSON.stringify(state).includes('PRIVATE-RESPONSE-ID'), false);
      assert.equal(JSON.stringify(state).includes('Chinese'), false);
      assert.equal(state.stack.length, 0);
    }
  });
  test(`${name}: reset null, empty IDs and absent legacy fields remain distinct`, () => {
    for (const value of [null, '', ' \t\n', 0, false, {}, []]) {
      const { result } = parse(JSON.stringify({ type: 'compacted', payload: { message: 'legacy summary', compaction_response_id: value } }));
      assert.deepEqual(result, { valid: true, responseIdPresent: true, responseIdNonempty: false, messageNonempty: true });
    }
    assert.deepEqual(parse('{"type":"compacted","payload":{"message":"legacy"}}').result,
      { valid: true, responseIdPresent: false, responseIdNonempty: false, messageNonempty: true });
    assert.equal(parse('{"type":"compacted","payload":{"compaction_response_id":"\\u0041"}}', 1).result.responseIdNonempty, true);
  });
  test(`${name}: cached parser snapshots resume through UTF-8 and escaped string boundaries`, () => {
    const source = Buffer.from('{"type":"compacted","payload":{"replacement_history":["中文😀\\uD83D\\uDE00"],"compaction_response_id":"fixture-response"}}');
    let state = createEnvelope();
    for (const byte of source) {
      consumeEnvelope(state, Buffer.from([byte]));
      assert.ok(state.utf8Carry.length <= 3);
      state = structuredClone(state);
    }
    assert.deepEqual(finishEnvelope(state), { valid: true, responseIdPresent: true, responseIdNonempty: true, messageNonempty: false });
  });
  test(`${name}: nested and escaped spoofed response fields never become direct metadata`, () => {
    const source = JSON.stringify({ type: 'compacted', replacement_history: { payload: { compaction_response_id: 'outside' } },
      payload: { replacement_history: [{ compaction_response_id: 'nested' }], message: '{"compaction_response_id":"escaped"}' } });
    assert.deepEqual(parse(source).result, { valid: true, responseIdPresent: false, responseIdNonempty: false, messageNonempty: true });
    assert.deepEqual(parse('{"payload":[{"compaction_response_id":"nested"}]}').result,
      { valid: true, responseIdPresent: false, responseIdNonempty: false, messageNonempty: false });
  });
  test(`${name}: response metadata after a huge replacement body is counted without retaining its content`, () => {
    const state = createEnvelope();
    consumeEnvelope(state, Buffer.from('{"type":"compacted","payload":{"replacement_history":["'));
    const chunk = Buffer.from('PRIVATE-HISTORY-CONTENT '.repeat(10000));
    for (let index = 0; index < 80; index++) {
      consumeEnvelope(state, chunk);
      assert.equal(JSON.stringify(state).includes('PRIVATE'), false);
      assert.ok(state.stack.length < 128);
    }
    consumeEnvelope(state, Buffer.from('"],"message":"","compaction_response_id":"not-retained"}}'));
    assert.deepEqual(finishEnvelope(state), { valid: true, responseIdPresent: true, responseIdNonempty: true, messageNonempty: false });
  });
  test(`${name}: escapes, Unicode keys, literals and JSON number grammar survive chunk splitting`, () => {
    const source = '{"type":"compacted","payl\\u006fad":{"message":"\\t\\n","compaction_response_\\u0069d":"\\uD83D\\uDE00","ignored":[true,false,null,-0,0,12,-45.67,8e9,-1.2E-3,"\\\"\\\\\\/\\b\\f\\n\\r\\t"]}}';
    assert.deepEqual(parse(source, 1).result, { valid: true, responseIdPresent: true, responseIdNonempty: true, messageNonempty: false });
    for (const number of ['-', '01', '-01', '+1', '.1', '1.', '1e', '1e+', 'NaN', 'Infinity']) {
      assert.equal(parse('{"ignored":' + number + '}').result.valid, false, number);
    }
  });
  test(`${name}: incomplete or malformed JSON cannot project a committed response ID`, () => {
    for (const source of [
      '', ' ', '{', '[', '{"type":"compacted","payload":{"compaction_response_id":"ok"}',
      '{"payload":{"compaction_response_id":"ok","message":"unterminated\n',
      '{"payload":{"compaction_response_id":"bad\\q"}}', '{"payload":{"message":"bad\\u12xz"}}',
      '{"a":truefalse}', '{"a":nullx}', '{"a":false,}', '[1,]', '{"a" 1}', '{"a":1 "b":2}',
      '{"a":1]','{}{}','{"a":"raw\tcontrol"}',
    ]) {
      const { result } = parse(source, 1);
      assert.equal(result.valid, false, source);
      assert.equal(result.responseIdPresent, false); assert.equal(result.responseIdNonempty, false);
    }
  });
  test(`${name}: maximum depth and key size fail closed without retaining unbounded input`, () => {
    assert.equal(parse('['.repeat(128) + '0' + ']'.repeat(128)).result.valid, true);
    const deep = parse('['.repeat(129) + '0' + ']'.repeat(129));
    assert.equal(deep.result.valid, false); assert.ok(deep.state.stack.length <= 128);
    assert.equal(parse('{"' + 'k'.repeat(128) + '":0}').result.valid, true);
    const long = parse('{"' + 'k'.repeat(129) + '":0}', 1);
    assert.equal(long.result.valid, false); assert.ok(long.state.token.text.length <= 128);
  });
  test(`${name}: duplicate payload fields follow JSON last-value semantics and finish is idempotent`, () => {
    assert.equal(parse('{"payload":{"compaction_response_id":"yes","compaction_response_id":null}}').result.responseIdNonempty, false);
    assert.equal(parse('{"payload":{"compaction_response_id":null,"compaction_response_id":"yes"}}').result.responseIdNonempty, true);
    assert.equal(parse('{"payload":{"compaction_response_id":"yes"},"payload":{}}').result.responseIdPresent, false);
    const { state, result } = parse('{"payload":{"compaction_response_id":"yes"}}');
    assert.deepEqual(finishEnvelope(state), result);
    consumeEnvelope(state, Buffer.from('garbage'));
    assert.deepEqual(finishEnvelope(state), result);
  });
}

test('compaction envelope mirrors are identical', async () => {
  assert.equal(await fs.readFile(path.join(__dirname, '../src/compaction-envelope.cjs'), 'utf8'),
    await fs.readFile(path.join(__dirname, '../macos/src/compaction-envelope.cjs'), 'utf8'));
});
