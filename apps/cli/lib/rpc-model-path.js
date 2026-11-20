import path from 'node:path';

// Model ids accepted by POST /v1/rpc/inference. The id selects a GGUF the
// operator already has; it is never a path. Before this, an absolute path or a
// "../" id was accepted, which let any client probe for files on the provider
// and make it spawn llama-server against arbitrary files.
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * Resolve a requested model id to a local GGUF path, or null when the id is
 * not acceptable. Operator-configured mappings (rpc_primary.gguf_paths) win;
 * otherwise the file must live directly under <home>/.infernet/models.
 */
export function resolveRpcModelPath(model, { ggufPaths = null, home = '/tmp' } = {}) {
    if (typeof model !== 'string' || !MODEL_ID.test(model) || model.includes('..')) return null;
    if (ggufPaths && Object.prototype.hasOwnProperty.call(ggufPaths, model) && ggufPaths[model]) {
        return ggufPaths[model];
    }
    const dir = path.resolve(home, '.infernet', 'models');
    const p = path.resolve(dir, `${model}.gguf`);
    if (path.dirname(p) !== dir) return null;
    return p;
}
