/**
 * `infernet help` — top-level usage.
 */

const USAGE = `infernet — GPU node control plane for the Infernet Protocol

Usage:
  infernet [prompt]                     Chat with the network (default verb)
  infernet <command> [args]             Run an explicit subcommand
  echo "..." | infernet                 Chat with the piped input

Setup:
  setup        Bootstrap environment (Ollama + model + firewall + config)
  model        Manage models (list / pull / remove / use / hf: prefix for HuggingFace)
  uncensored   Download an uncensored LLM (auto-picks by VRAM, serve via vLLM)

Node lifecycle:
  init         Configure this node (control-plane URL, role, Nostr identity)
  login        Update the control-plane URL
  register     Register this node with the control plane (signed)
  update       Push current capability/status to the control plane (signed)
  upgrade      Re-run the curl installer to pull the latest CLI, then re-register
  remove       Deregister this node, wipe local config, and uninstall the CLI

Daemon:
  start        Start the node daemon (detached by default)
  stop         Stop the running daemon
  status       Show this node's current state (remote row + live daemon)
  stats        Live in-memory stats from the running daemon (via IPC)
  logs         Show / tail the daemon log (~/.config/infernet/daemon.log)
  service      Userland systemd unit (Linux): install / enable / status / logs

Diagnostics:
  gpu          Inspect local GPUs (nvidia-smi / rocm-smi / system_profiler)
  firewall     Print commands to open the P2P port on your firewall
  chat         Run an inference (P2P network or --local engine)
  tui          Live terminal dashboard (system / jobs / engine / peers)
  doctor       End-to-end health check across all three sides

Payments:
  payout       Manage payout coin/address
  payments     Show recent payment transactions

Managed endpoints:
  reservation  Book a pinned operator + exact model by the hour; keys, limits,
               per-minute availability report, post-paid invoice data
  mcp          MCP server (stdio) exposing the reservation tools

Other:
  help         Show this help

Run \`infernet <command> --help\` for per-command help.
`;

export default async function help() {
    process.stdout.write(USAGE);
}

export { USAGE };
