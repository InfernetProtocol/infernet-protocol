/**
 * `infernet quickstart` — the Infernet API in one command.
 *
 *   npx @infernetprotocol/cli quickstart
 *
 * Signs you in (browser device code) if needed, creates an API key, keeps it
 * in ~/.config/infernet/config.json (0600, never a project file), runs one
 * real completion with model "auto" and prints copy-paste code for curl,
 * fetch, the OpenAI SDK and Python. Run it again any time: with a key already
 * configured it goes straight to the test call.
 *
 *   infernet quickstart status    key? balance? free requests left? live models?
 *   infernet quickstart key       print the stored key (for eval / export)
 *   infernet models               models live on the network right now
 */
import { loadConfig, getConfigPath } from '../lib/config.js';
import { createBatchClient } from '../lib/batch-client.js';
import {
    createApiClient, resolveApiKey, resolveBaseUrl, saveApiKey, looksLikeApiKey, maskKey, snippets
} from '../lib/api-client.js';
import { deviceCodeFlow } from './login.js';

export const QUICKSTART_HELP = `infernet quickstart — use the Infernet API in one command

Usage:
  infernet quickstart                 sign in, create + store an API key, test it, print code
  infernet quickstart status          key configured? balance, free requests left, live models
  infernet quickstart key             print the stored key, e.g.
                                        export INFERNET_API_KEY="$(infernet quickstart key)"
  infernet models                     models live on the network right now

Options:
  --key <ik_live_...>   store an existing key instead of creating one
  --name <label>        name for a new key (default: quickstart)
  --prompt <text>       the test prompt
  --model <id>          the test model (default: auto, a live model picked for you)
  --no-test             skip the test call
  --json                machine-readable output (for agents and scripts)
  --url <base>          API base (default https://infernetprotocol.com)

Idempotent: with a key already set (INFERNET_API_KEY or a stored one) it skips
sign-in and key creation and only runs the test call.

API:  https://infernetprotocol.com/v1  (OpenAI-compatible, Bearer ik_live_...)
Free: 10 requests a day on small models; paid use spends your compute balance
      (\`infernet billing topup <usd>\`). The CLI never switches you to another provider.
`;

const DEFAULT_PROMPT = 'Say hello in one short, friendly sentence.';

function writer(stream) {
    return { write: (s) => stream.write(s) };
}

/**
 * The quickstart, injectable for tests. Returns { code, result }.
 * deps: { fetchImpl, login(config, opts) -> exit code, isTTY, out, err }
 */
export async function runQuickstart(opts = {}, deps = {}) {
    const fetchImpl = deps.fetchImpl ?? fetch;
    const out = deps.out ?? writer(process.stdout);
    const err = deps.err ?? writer(process.stderr);
    const json = !!opts.json;
    const say = json ? () => {} : (s) => out.write(s);
    // Progress goes to stderr in JSON mode so stdout stays one JSON document.
    const progress = json ? err : out;
    const login = deps.login ?? ((config, o) => deviceCodeFlow(config, o));
    const isTTY = deps.isTTY ?? !!process.stdout.isTTY;

    let config = (await loadConfig().catch(() => null)) ?? {};
    const baseUrl = resolveBaseUrl({ flag: opts.url, config });
    const result = { base_url: baseUrl, api_base: `${baseUrl}/v1`, config_path: getConfigPath() };

    // 1. A key: flag > env > stored. A flag key is stored; an env key is the
    //    person's own business and is left where it is.
    let { key, source } = resolveApiKey({ flag: opts.key, config });
    let created = false;
    if (key && !looksLikeApiKey(key)) {
        err.write(`error: ${source} does not look like an Infernet API key (expected ${'ik_live_'}...)\n`);
        return { code: 2, result };
    }
    if (key && source === '--key') {
        await saveApiKey({ key, name: opts.name ?? null });
        source = 'config';
        say(`✓ Key saved to ${getConfigPath()}\n`);
    } else if (key) {
        say(`✓ Using your API key ${maskKey(key)} (from ${source === 'config' ? getConfigPath() : source})\n`);
    }

    if (!key) {
        // 2. Signed in? If not (or the saved sign-in is refused), the browser
        //    device-code flow.
        const signIn = async () => {
            say('Step 1/3  Sign in (a browser window opens; sign up there if you are new)\n');
            const code = await login(config, { baseUrl, out: progress });
            if (code !== 0) {
                err.write('Sign-in did not finish. Run `infernet quickstart` again, or paste an existing key: infernet quickstart --key ik_live_...\n');
                return code || 1;
            }
            config = (await loadConfig().catch(() => null)) ?? {};
            return 0;
        };
        let signedInNow = false;
        if (!config?.auth?.bearerToken) {
            const code = await signIn();
            if (code !== 0) return { code, result };
            signedInNow = true;
        }
        // 3. Create the key with the login bearer.
        say('Step 2/3  Creating an API key\n');
        const createKey = () => createBatchClient({ baseUrl, apiKey: null, userToken: config?.auth?.bearerToken, fetchImpl })
            .createKey(opts.name ?? 'quickstart');
        let k;
        try {
            k = await createKey();
        } catch (e) {
            if (e?.status !== 401 || signedInNow) throw e;
            // A stale or rotated sign-in: sign in again once, then retry.
            say('Your saved sign-in has expired.\n');
            const code = await signIn();
            if (code !== 0) return { code, result };
            k = await createKey();
        }
        key = k.key;
        source = 'config';
        created = true;
        await saveApiKey({ key, id: k.id ?? null, name: opts.name ?? 'quickstart' });
        result.key_id = k.id ?? null;
        say(`✓ API key created and saved to ${getConfigPath()} (mode 0600)\n`);
    }

    result.key_source = source;
    result.key_masked = maskKey(key);
    result.key_created = created;

    // 4. One real call.
    const api = createApiClient({ baseUrl, apiKey: key, fetchImpl });
    if (!opts.noTest) {
        say(`${created ? 'Step 3/3  ' : ''}Test call: model "${opts.model ?? 'auto'}"\n\n  `);
        try {
            const r = await api.chat({
                messages: [{ role: 'user', content: opts.prompt ?? DEFAULT_PROMPT }],
                model: opts.model ?? 'auto',
                maxTokens: 120,
                onToken: json ? () => {} : (t) => out.write(t.replace(/\n/g, '\n  '))
            });
            result.test = { ok: true, model: r.model, text: r.text, source: r.source };
            say(`\n\n✓ Answered by ${r.model}${r.source ? ` via ${r.source}` : ''}\n`);
        } catch (e) {
            result.test = { ok: false, status: e?.status ?? null, error: e?.message ?? String(e) };
            if (!json) err.write(`\n\n✗ Test call failed: ${e?.message ?? e}\n`);
        }
    }

    // 5. Copy-paste code and the next steps.
    const sn = snippets(baseUrl);
    result.snippets = sn;
    if (!json) {
        say('\nYour key, for this shell:\n');
        if (created && isTTY) {
            say(`  export INFERNET_API_KEY=${key}\n`);
            say('  (shown once here; it stays in your infernet config, never in a project file)\n');
        } else {
            say('  export INFERNET_API_KEY="$(infernet quickstart key)"\n');
        }
        say(`\nAPI base: ${baseUrl}/v1   model: "auto" or any id from \`infernet models\`\n`);
        say(`\n── curl ──\n${sn.curl}\n`);
        say(`\n── JavaScript (fetch) ──\n${sn.fetch}\n`);
        say(`\n── JavaScript (OpenAI SDK) ──\n${sn.openaiJs}\n`);
        say(`\n── Python (OpenAI SDK) ──\n${sn.python}\n`);
        say('\nNext:\n'
            + '  infernet chat "your prompt"          one-line chat with this key\n'
            + '  infernet quickstart status           balance, free requests left, live models\n'
            + '  claude plugin marketplace add InfernetProtocol/infernet-protocol\n'
            + '  claude plugin install infernet@infernet   Infernet inside Claude Code\n'
            + `  Docs: ${baseUrl}/docs#quickstart\n`);
    } else {
        out.write(`${JSON.stringify(result, null, 2)}\n`);
    }
    return { code: result.test && !result.test.ok ? 1 : 0, result };
}

/** `infernet quickstart status`: everything about this machine's API access. */
export async function runStatus(opts = {}, deps = {}) {
    const fetchImpl = deps.fetchImpl ?? fetch;
    const out = deps.out ?? writer(process.stdout);
    const config = (await loadConfig().catch(() => null)) ?? {};
    const baseUrl = resolveBaseUrl({ flag: opts.url, config });
    const { key, source } = resolveApiKey({ flag: opts.key, config });
    const api = createApiClient({ baseUrl, apiKey: key, fetchImpl });
    const status = {
        api_base: `${baseUrl}/v1`,
        key_configured: !!key,
        key_source: source,
        key_masked: key ? maskKey(key) : null,
        signed_in: !!config?.auth?.bearerToken
    };
    try { status.live_models = await api.models(); } catch (e) { status.live_models_error = e?.message ?? String(e); }
    if (key) {
        try {
            const b = await api.balance();
            status.balance = {
                total_spendable_usd: b.total_spendable_usd ?? null,
                prepaid_available_usd: b.prepaid_available_usd ?? null,
                earned_spendable_usd: b.earned_spendable_usd ?? null
            };
            if (b.free_today) status.free_today = b.free_today;
        } catch (e) {
            status.balance_error = e?.message ?? String(e);
        }
    }
    if (opts.json) {
        out.write(`${JSON.stringify(status, null, 2)}\n`);
    } else {
        out.write(`API base:     ${status.api_base}\n`);
        out.write(`API key:      ${key ? `${status.key_masked} (${source === 'config' ? getConfigPath() : source})` : 'none  → run `infernet quickstart`'}\n`);
        if (status.balance) out.write(`Balance:      $${status.balance.total_spendable_usd ?? '0'} spendable\n`);
        if (status.balance_error) out.write(`Balance:      ${status.balance_error.split('\n')[0]}\n`);
        if (status.free_today) out.write(`Free today:   ${status.free_today.remaining} of ${status.free_today.limit} requests left (small models; resets 00:00 UTC)\n`);
        if (status.live_models) out.write(`Live models:  ${status.live_models.length}  (${status.live_models.slice(0, 6).join(', ')}${status.live_models.length > 6 ? ', …' : ''})\n`);
        if (status.live_models_error) out.write(`Live models:  ${status.live_models_error}\n`);
    }
    return { code: key ? 0 : 1, status };
}

export async function models(args) {
    if (args.has('help') || args.has('h')) {
        process.stdout.write('infernet models — models live on the Infernet network right now (GET /v1/models)\n\n  infernet models [--json] [--url <base>]\n\nPass any id as "model", or "auto" to let the network pick.\n');
        return 0;
    }
    const config = (await loadConfig().catch(() => null)) ?? {};
    const api = createApiClient({ baseUrl: resolveBaseUrl({ flag: args.get('url'), config }) });
    const ids = await api.models();
    if (args.has('json')) process.stdout.write(`${JSON.stringify(ids, null, 2)}\n`);
    else process.stdout.write(ids.length ? `${ids.join('\n')}\n` : 'No models online right now; try again shortly.\n');
    return 0;
}

export default async function quickstart(args) {
    // Reclaim a word the greedy parser took as a boolean flag's value
    // ("--json status" is "status" with --json).
    const positional = [...(args.positional ?? [])];
    for (const name of ['json', 'no-test']) {
        const v = args.get(name);
        if (typeof v === 'string') positional.unshift(v);
    }
    const [sub] = positional;
    if (args.has('help') || args.has('h') || sub === 'help') {
        process.stdout.write(QUICKSTART_HELP);
        return 0;
    }
    const opts = {
        key: args.get('key'),
        name: args.get('name'),
        prompt: args.get('prompt'),
        model: args.get('model'),
        url: args.get('url'),
        json: args.has('json'),
        noTest: args.has('no-test')
    };
    if (sub === 'status') return (await runStatus(opts)).code;
    if (sub === 'key') {
        const config = (await loadConfig().catch(() => null)) ?? {};
        const { key } = resolveApiKey({ config });
        if (!key) {
            process.stderr.write('No API key yet. Run `infernet quickstart`.\n');
            return 1;
        }
        process.stdout.write(`${key}\n`);
        return 0;
    }
    if (sub) {
        process.stderr.write(`unknown subcommand: ${sub}\n\n${QUICKSTART_HELP}`);
        return 2;
    }
    return (await runQuickstart(opts)).code;
}
