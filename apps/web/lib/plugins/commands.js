// Pure helpers for the /plugin chat commands (shared by the page and tests).

/** `/plugin add <x>`, `/plugin ls`, `/plugin rm <slug>`, `/plugin on|off <slug>`, `/plugins`. */
export function parsePluginCommand(text) {
  const m = /^\/plugins?\b\s*(.*)$/is.exec(String(text ?? "").trim());
  if (!m) return null;
  const [sub = "", ...rest] = m[1].trim().split(/\s+/).filter(Boolean);
  const arg = rest.join(" ");
  const s = sub.toLowerCase();
  if (!s || s === "panel") return { action: "panel" };
  if (s === "ls" || s === "list") return { action: "ls" };
  if (s === "add" || s === "install") return { action: "add", arg };
  if (s === "rm" || s === "remove" || s === "delete") return { action: "rm", arg };
  if (s === "on" || s === "enable") return { action: "on", arg };
  if (s === "off" || s === "disable") return { action: "off", arg };
  if (s === "connect" || s === "login" || s === "signin") return { action: "connect", arg };
  // "/plugin https://..." or "/plugin c0mpute" = add
  return { action: "add", arg: [sub, ...rest].join(" ") };
}

export function describePlugins(plugins) {
  if (!plugins.length) return "No plugins yet. Try `/plugin add c0mpute` or `/plugin add https://example.com/mcp`, or open the Plugins panel.";
  return plugins.map((p) => {
    const state = p.needs_sign_in ? "needs sign-in" : p.enabled ? "on" : "off";
    return `- **${p.name}** (\`${p.slug}\`): ${state}, ${p.tools.length} tool${p.tools.length === 1 ? "" : "s"}`;
  }).join("\n");
}

