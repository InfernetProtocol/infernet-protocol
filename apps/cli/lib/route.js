/**
 * CLI routing decisions, extracted so they're independently testable.
 *
 * `infernet` follows the claude / codex / qwen UX convention: bare
 * positional input that isn't a known subcommand is treated as a
 * chat prompt. This keeps `infernet "what is 2+2"` and
 * `echo "…" | infernet` working without forcing users to remember
 * the `chat` keyword.
 *
 * Routing rules (in order):
 *
 *   1. argv[0] in {help, --help, -h}                      → help
 *   2. argv empty + TTY  (`infernet` with no input)       → help (don't
 *                                                          surprise the
 *                                                          user with a
 *                                                          chat REPL)
 *   3. argv empty + piped stdin  (`echo … | infernet`)    → chat
 *   4. argv[0] is a known subcommand                      → that command
 *   5. argv[0] looks like a command word and argv is short
 *      (`infernet house-models off`) but is not one we know → unknown
 *      command. Sending it to chat would turn an operator's command (an
 *      opt-out, even) into a prompt to a model, which is what a stale CLI
 *      copy shadowing a newer one on PATH did on 2026-11-02.
 *   6. argv[0] is anything else                           → chat with
 *                                                          all of argv as
 *                                                          the prompt
 *
 * Free text still chats: `infernet "what is 2+2"` (a space in the first
 * token), `infernet what is 2+2?` (punctuation) and longer prompts
 * (`infernet tell me a joke`) all go to chat.
 */

/** A token that could only be a subcommand name: `house-models`, `doctor`. */
export const COMMAND_WORD_RE = /^[a-z][a-z0-9-]*$/;
/** Tokens after it that read like subcommand args: `sync`, `off`, `8`, `--yes`. */
const ARG_WORD_RE = /^(?:-{1,2}[a-z0-9][a-z0-9-]*(?:=\S*)?|[a-z0-9][a-z0-9._-]*)$/i;
/** `infernet house-models uncensored off` is the longest real command shape. */
export const MAX_COMMAND_TOKENS = 3;

export function looksLikeCommand(argv) {
    if (!Array.isArray(argv) || argv.length === 0 || argv.length > MAX_COMMAND_TOKENS) return false;
    if (!COMMAND_WORD_RE.test(argv[0])) return false;
    return argv.slice(1).every((t) => typeof t === 'string' && ARG_WORD_RE.test(t));
}

export function decideRoute(argv, knownCommands, { isTTY = true } = {}) {
    if (!Array.isArray(argv)) throw new TypeError("decideRoute: argv must be an array");
    if (!(knownCommands instanceof Set)) throw new TypeError("decideRoute: knownCommands must be a Set");

    const sub = argv[0];

    if (sub === "help" || sub === "--help" || sub === "-h") {
        return { command: "help", rest: [] };
    }

    if (sub === undefined) {
        if (isTTY) return { command: "help", rest: [] };
        return { command: "chat", rest: [] };
    }

    if (knownCommands.has(sub)) {
        return { command: sub, rest: argv.slice(1) };
    }

    if (looksLikeCommand(argv)) {
        return { command: "unknown", name: sub, rest: argv.slice(1) };
    }

    return { command: "chat", rest: argv };
}

/** The message for rule 5: say which CLI answered so a stale copy is obvious. */
export function unknownCommandMessage(name, { version, entry } = {}) {
    const which = version ? `this CLI is v${version}${entry ? ` at ${entry}` : ''}` : 'this CLI';
    return `infernet: unknown command '${name}' (${which}; run \`infernet upgrade\` if it should exist)\n`
        + `  to ask a model instead, quote the prompt: infernet "${name} ..." or infernet chat ...\n`
        + `  all commands: infernet help\n`;
}
