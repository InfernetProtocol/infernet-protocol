import { describe, expect, it } from "vitest";
import { decideRoute, looksLikeCommand, unknownCommandMessage } from "../apps/cli/lib/route.js";

const KNOWN = new Set([
    "init", "login", "register", "update", "remove",
    "start", "status", "stop", "stats", "logs",
    "payout", "payments", "gpu", "firewall",
    "chat", "setup", "model", "tui", "doctor", "service",
    "help"
]);

describe("decideRoute — explicit help shortcuts", () => {
    it("'help' → help command", () => {
        expect(decideRoute(["help"], KNOWN)).toEqual({ command: "help", rest: [] });
    });
    it("'--help' → help command", () => {
        expect(decideRoute(["--help"], KNOWN)).toEqual({ command: "help", rest: [] });
    });
    it("'-h' → help command", () => {
        expect(decideRoute(["-h"], KNOWN)).toEqual({ command: "help", rest: [] });
    });
});

describe("decideRoute — bare invocation", () => {
    it("no args + TTY → help (don't surprise with a chat REPL)", () => {
        const r = decideRoute([], KNOWN, { isTTY: true });
        expect(r).toEqual({ command: "help", rest: [] });
    });

    it("no args + piped stdin → chat (read prompt from stdin)", () => {
        const r = decideRoute([], KNOWN, { isTTY: false });
        expect(r).toEqual({ command: "chat", rest: [] });
    });
});

describe("decideRoute — known subcommands", () => {
    it("dispatches a known subcommand verbatim", () => {
        expect(decideRoute(["init"], KNOWN)).toEqual({ command: "init", rest: [] });
    });

    it("forwards remaining args as rest", () => {
        expect(decideRoute(["init", "--url", "https://x"], KNOWN))
            .toEqual({ command: "init", rest: ["--url", "https://x"] });
    });

    it("explicit chat still works (rest carries the prompt)", () => {
        expect(decideRoute(["chat", "what is 2+2?"], KNOWN))
            .toEqual({ command: "chat", rest: ["what is 2+2?"] });
    });

    it("explicit chat + flags", () => {
        expect(decideRoute(["chat", "--backend", "stub", "ping"], KNOWN))
            .toEqual({ command: "chat", rest: ["--backend", "stub", "ping"] });
    });
});

describe("decideRoute — implicit chat (default verb)", () => {
    it("a single word with punctuation routes to chat", () => {
        expect(decideRoute(["hello?"], KNOWN))
            .toEqual({ command: "chat", rest: ["hello?"] });
    });

    it("a quoted multi-word prompt routes to chat with all of argv", () => {
        expect(decideRoute(["what is 2+2?"], KNOWN))
            .toEqual({ command: "chat", rest: ["what is 2+2?"] });
    });

    it("multi-word unquoted argv routes to chat with the whole argv as rest", () => {
        expect(decideRoute(["what", "is", "2+2?"], KNOWN))
            .toEqual({ command: "chat", rest: ["what", "is", "2+2?"] });
    });

    it("flags before a non-command first token still route to chat", () => {
        expect(decideRoute(["--json", "what is 2+2?"], KNOWN))
            .toEqual({ command: "chat", rest: ["--json", "what is 2+2?"] });
    });
});

describe("decideRoute — defensive contracts", () => {
    it("requires argv to be an array", () => {
        expect(() => decideRoute("init", KNOWN)).toThrow(/argv must be an array/);
    });

    it("requires knownCommands to be a Set", () => {
        expect(() => decideRoute(["init"], ["init", "chat"])).toThrow(/must be a Set/);
    });

    it("does not mutate argv", () => {
        const argv = ["chat", "ping"];
        decideRoute(argv, KNOWN);
        expect(argv).toEqual(["chat", "ping"]);
    });
});

describe("decideRoute — protects against subcommand collision", () => {
    // If we ever name a subcommand "what" or "hello", we'd accidentally
    // capture user prompts. These tests pin the current command list so
    // a future rename-to-something-common gets a CI failure that points
    // at this property.
    it("'init' is reserved and not a chat prompt", () => {
        expect(decideRoute(["init", "stuff"], KNOWN).command).toBe("init");
    });

    it("a capitalized single word still routes to chat (commands are lowercase)", () => {
        expect(decideRoute(["Hello"], KNOWN).command).toBe("chat");
    });
});

describe("decideRoute — unknown command words are not prompts", () => {
    // 2026-11-02, bonita: a stale 0.1.80 CLI shadowed 0.1.83 on PATH and sent
    // `infernet house-models off` (the house-models opt-out) to a model.
    it("an unknown command word errors instead of chatting", () => {
        expect(decideRoute(["house-models"], KNOWN)).toEqual({ command: "unknown", name: "house-models", rest: [] });
    });

    it("an unknown command with subcommand args errors", () => {
        expect(decideRoute(["house-models", "sync"], KNOWN)).toEqual({ command: "unknown", name: "house-models", rest: ["sync"] });
        expect(decideRoute(["house-models", "off"], KNOWN).command).toBe("unknown");
        expect(decideRoute(["house-models", "uncensored", "off"], KNOWN).command).toBe("unknown");
        expect(decideRoute(["house-models", "cap", "8"], KNOWN).command).toBe("unknown");
        expect(decideRoute(["frobnicate", "--yes"], KNOWN).command).toBe("unknown");
        expect(decideRoute(["hello"], KNOWN).command).toBe("unknown");
    });

    it("free text in quotes still chats", () => {
        expect(decideRoute(["free text question"], KNOWN)).toEqual({ command: "chat", rest: ["free text question"] });
        expect(decideRoute(["house-models off please"], KNOWN).command).toBe("chat");
    });

    it("multi-word prompts still chat", () => {
        expect(decideRoute(["tell", "me", "a", "joke"], KNOWN).command).toBe("chat");
        expect(decideRoute(["what", "is", "2+2?"], KNOWN).command).toBe("chat");
        expect(decideRoute(["why", "is", "the", "sky", "blue"], KNOWN).command).toBe("chat");
    });

    it("known commands are unaffected", () => {
        const known = new Set([...KNOWN, "house-models"]);
        expect(decideRoute(["house-models", "off"], known)).toEqual({ command: "house-models", rest: ["off"] });
    });

    it("looksLikeCommand pins the shape", () => {
        expect(looksLikeCommand(["doctor"])).toBe(true);
        expect(looksLikeCommand(["a-b", "c", "d"])).toBe(true);
        expect(looksLikeCommand(["a-b", "c", "d", "e"])).toBe(false);
        expect(looksLikeCommand(["what is this"])).toBe(false);
        expect(looksLikeCommand(["9lives"])).toBe(false);
        expect(looksLikeCommand([])).toBe(false);
    });

    it("the error names the running CLI version and says to upgrade", () => {
        const msg = unknownCommandMessage("house-models", { version: "0.1.80", entry: "/x/cli" });
        expect(msg).toMatch(/unknown command 'house-models' \(this CLI is v0\.1\.80 at \/x\/cli; run `infernet upgrade`/);
    });
});
