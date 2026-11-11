/**
 * `infernet plugins` — chat plugins: remote MCP servers the model can use in
 * `infernet chat`, /chat on the site, and the desktop app.
 *
 *   infernet plugins                       list yours (and the catalog)
 *   infernet plugins add <url|name>        add one; opens the browser to sign in if it asks
 *   infernet plugins rm <slug>             remove
 *   infernet plugins on|off <slug>         turn on or off
 *   infernet plugins connect <slug>        sign in again
 */
import { createPluginsClient, openBrowser, resolvePluginsOptions } from '../lib/plugins-client.js';

export const PLUGINS_HELP = `infernet plugins — tools the model can use in chat (remote MCP servers)

Usage:
  infernet plugins                      Your plugins and the catalog
  infernet plugins add <url|name>       Add by URL (https://.../mcp) or catalog name (c0mpute, threatcrush).
                                        If it wants sign-in, a browser opens on its own page; on a
                                        headless box the one-time link is printed instead.
  infernet plugins rm <slug>            Remove a plugin and its tokens
  infernet plugins on <slug>            Turn on
  infernet plugins off <slug>           Turn off
  infernet plugins connect <slug>       Sign in (again)

Options: --json, --url <base>, --token <bearer>, --no-browser
Signed-in account required (\`infernet login\`). \`infernet chat\` uses enabled plugins automatically.
`;

function out(args, data, text) {
    process.stdout.write(args.has('json') ? `${JSON.stringify(data, null, 2)}\n` : `${text}\n`);
}

function line(p) {
    const state = p.needs_sign_in ? 'needs sign-in' : p.enabled ? 'on' : 'off';
    return `  ${p.slug.padEnd(16)} ${state.padEnd(14)} ${String(p.tools.length).padStart(3)} tools  ${p.name}  ${p.url}`;
}

function signInHint(args, url) {
    const opened = !args.has('no-browser') && openBrowser(url);
    return opened
        ? `Opened your browser to sign in. If nothing appeared, open:\n  ${url}`
        : `Open this link in any browser to sign in (valid 15 minutes):\n  ${url}`;
}

export default async function plugins(args) {
    const [sub = 'ls', ...rest] = args.positional ?? [];
    if (args.has('help') || args.has('h') || sub === 'help') {
        process.stdout.write(PLUGINS_HELP);
        return 0;
    }
    const c = createPluginsClient(await resolvePluginsOptions({ url: args.get('url'), token: args.get('token') }));
    const arg = rest.join(' ').trim();
    try {
        if (sub === 'ls' || sub === 'list') {
            const d = await c.list();
            const mine = d.plugins ?? [];
            const have = new Set(mine.map((p) => p.url));
            const text = [
                mine.length ? 'Your plugins:' : 'No plugins yet.',
                ...mine.map(line),
                '',
                'Catalog (infernet plugins add <name>):',
                ...(d.catalog ?? []).map((e) => `  ${e.slug.padEnd(16)} ${have.has(e.url) ? 'added' : '     '}  ${e.name}: ${e.description ?? e.url}`)
            ].join('\n');
            out(args, d, text);
            return 0;
        }
        if (sub === 'add' || sub === 'install') {
            if (!arg) { process.stderr.write('Usage: infernet plugins add <url|name>\n'); return 2; }
            const r = await c.add(arg);
            const p = r.plugin;
            let text = r.already ? `${p.name} (${p.slug}) is already added.` : `Added ${p.name} (${p.slug}), ${p.tools.length} tools.`;
            if (r.connect_url && p.needs_sign_in) text += `\n${signInHint(args, r.connect_url)}`;
            else if (r.connect_url && p.can_sign_in) text += `\nIt also offers sign-in for more tools: infernet plugins connect ${p.slug}`;
            out(args, r, text);
            return 0;
        }
        if (sub === 'connect' || sub === 'login') {
            if (!arg) { process.stderr.write('Usage: infernet plugins connect <slug>\n'); return 2; }
            const r = await c.add((await c.list()).plugins.find((p) => p.slug === arg)?.url ?? arg);
            if (!r.connect_url) { out(args, r, `${r.plugin.name} does not use sign-in.`); return 0; }
            out(args, r, signInHint(args, r.connect_url));
            return 0;
        }
        if (sub === 'rm' || sub === 'remove' || sub === 'delete') {
            if (!arg) { process.stderr.write('Usage: infernet plugins rm <slug>\n'); return 2; }
            out(args, await c.remove(arg), `Removed ${arg}.`);
            return 0;
        }
        if (sub === 'on' || sub === 'off' || sub === 'enable' || sub === 'disable') {
            if (!arg) { process.stderr.write(`Usage: infernet plugins ${sub} <slug>\n`); return 2; }
            const on = sub === 'on' || sub === 'enable';
            const p = await c.toggle(arg, on);
            out(args, p, `${p.slug} is ${p.enabled ? 'on' : 'off'}.`);
            return 0;
        }
        process.stderr.write(`Unknown subcommand: ${sub}\n\n${PLUGINS_HELP}`);
        return 2;
    } catch (err) {
        process.stderr.write(`${err.message}\n`);
        return 1;
    }
}
