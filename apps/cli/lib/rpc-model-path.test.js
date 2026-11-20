import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRpcModelPath } from './rpc-model-path.js';

const home = '/home/op';

test('plain ids resolve under ~/.infernet/models', () => {
    assert.equal(resolveRpcModelPath('qwen2.5-1.5b', { home }), '/home/op/.infernet/models/qwen2.5-1.5b.gguf');
    assert.equal(resolveRpcModelPath('llama3:8b', { home }), '/home/op/.infernet/models/llama3:8b.gguf');
});

test('operator mappings win', () => {
    assert.equal(resolveRpcModelPath('m', { home, ggufPaths: { m: '/data/m.gguf' } }), '/data/m.gguf');
});

test('paths and traversal are refused', () => {
    for (const bad of ['/etc/shadow', '/etc/forgejo/app.ini', '../../../etc/passwd', 'a/../../b', 'x/y',
        '..', '.hidden', '', ' ', 'a b', 'toString', '__proto__', null, 42, 'a'.repeat(200)]) {
        const ggufPaths = bad === 'toString' ? {} : undefined;
        const r = resolveRpcModelPath(bad, { home, ggufPaths });
        if (bad === 'toString') {
            assert.equal(r, '/home/op/.infernet/models/toString.gguf', 'prototype keys must not map');
        } else {
            assert.equal(r, null, `expected null for ${JSON.stringify(bad)}`);
        }
    }
});
