'use strict';
// Immutable upstream revision. No user text or credential is ever sent to the Hub.
module.exports = Object.freeze({
  schema: 1, model: 'Xenova/multilingual-e5-small', revision: '761b726dd34fb83930e26aab4e9ac3899aa1fa78',
  upstream: 'intfloat/multilingual-e5-small', upstreamRevision: '614241f622f53c4eeff9890bdc4f31cfecc418b3',
  license: 'MIT', licenseFile: 'licenses/multilingual-e5-MIT.txt', source: 'https://huggingface.co/Xenova/multilingual-e5-small/tree/761b726dd34fb83930e26aab4e9ac3899aa1fa78', runtime: '@huggingface/transformers', runtimeVersion: '3.8.1', onnxRuntimeVersion: '1.21.0',
  dimensions: 384, maximumTokens: 512, dtype: 'q8', pooling: 'mean', normalize: true,
  queryPrefix: 'query: ', passagePrefix: 'passage: ',
  files: Object.freeze({
    'config.json': { size: 658, sha256: 'cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1' },
    'tokenizer.json': { size: 17082730, sha256: '0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39' },
    'tokenizer_config.json': { size: 443, sha256: 'a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b' },
    'special_tokens_map.json': { size: 167, sha256: 'd05497f1da52c5e09554c0cd874037a083e1dc1b9cfd48034d1c717f1afc07a7' },
    'onnx/model_quantized.onnx': { size: 118308185, sha256: 'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193' },
  }),
});
