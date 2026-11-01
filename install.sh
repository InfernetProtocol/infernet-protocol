#!/bin/sh
# Infernet Protocol — one-line installer for the `infernet` CLI.
#
# Usage:
#   curl -fsSL https://infernetprotocol.com/install.sh | sh
#
# Mirror (always pinned to master):
#   curl -fsSL https://raw.githubusercontent.com/infernetprotocol/infernet-protocol/master/install.sh | sh
#
# What it does:
#   1. Detects platform (Linux or macOS — Windows not supported yet).
#   2. Verifies Node.js 18+ is installed (prints how to install if not).
#   3. Installs pnpm if missing.
#   4. Clones the repo to ~/.infernet/source (or pulls if already present).
#   5. Runs `pnpm install` against the workspace.
#   6. Drops a wrapper script at ~/.local/bin/infernet that exec's the CLI.
#   7. Prints next steps (`infernet setup`).
#
# Install strategy:
#   1. If `npm` is available AND the package matches this source release, run
#      `npm install -g @infernetprotocol/cli`. Fast, ~5MB.
#   2. Otherwise fall back to `git clone` + `pnpm install` into
#      ~/.infernet/source and a wrapper at ~/.local/bin/infernet.
#      This keeps self-updates working when a release is available on GitHub
#      before the npm publish credentials are restored.
#
# The git path stays as a fallback so the installer works even before
# the npm package is published (e.g. for early-access releases).
#
# Override env vars:
#   INFERNET_HOME=/path           install dir for git fallback (~/.infernet)
#   INFERNET_BIN=/path/dir        wrapper bin dir (~/.local/bin)
#   INFERNET_REF=branch           branch/tag/commit for git path (master)
#   INFERNET_NPM_VERSION=X.Y.Z    pin npm version (latest)
#   INFERNET_FORCE_GIT=1          skip npm, force git path
#   INFERNET_MIN_DISK_MB=N        override disk-space threshold (3 / 10 / 15 GB)
#   INFERNET_SKIP_DISK_CHECK=1    skip the disk-space preflight
#   INFERNET_NO_RELOCATE=1        keep install at $HOME even if a bigger
#                                 volume is mounted (default: relocate to
#                                 the biggest writable mount when it has
#                                 ≥2x more free space than $HOME)
#
# Engine selection (optional):
#
#   INFERNET_INSTALL_VLLM=0       skip vLLM install even on NVIDIA
#   INFERNET_INSTALL_VLLM=1       force vLLM install (fails on non-NVIDIA)
#   INFERNET_VLLM_MODEL=name      auto-start `vllm serve <name>` in background
#                                 after install (e.g. Qwen/Qwen2.5-7B-Instruct)
#
# Ray cluster (optional, for multi-GPU / multi-node vLLM serving):
#
#   INFERNET_RAY_MODE=head        start a Ray head on this box (port 6379)
#   INFERNET_RAY_MODE=worker      join an existing Ray cluster
#   INFERNET_RAY_HEAD=host:port   address of the Ray head (when MODE=worker)
#   INFERNET_RAY_PORT=6379        head port (default 6379)
#
# CPU baseline model (always pulled — every node has a CPU):
#
#   INFERNET_CPU_BASELINE_MODEL=name  default qwen2.5:0.5b (≈400 MB)
#   INFERNET_SKIP_CPU_BASELINE=1      skip the unconditional baseline pull
#
# Auto-bootstrap (everything below is optional — the script still works
# without them, but with these set it leaves the node fully running
# without ever needing an interactive `infernet setup` afterwards):
#
#   INFERNET_BEARER=<JWT>         24h CLI bearer minted at /deploy. Auto-links
#                                 the node to the issuing user's account.
#   INFERNET_CONTROL_PLANE=URL    default https://infernetprotocol.com
#   INFERNET_MODEL=name           default qwen2.5:7b
#   INFERNET_NODE_ROLE=role       provider | aggregator | client (default provider)
#   INFERNET_NODE_NAME=name       human-readable name (default user@host)
#   INFERNET_PUBLIC_PORT=port     P2P port (default 46337)
#   INFERNET_AUTOSTART=0          set to 0 to install only, skip setup+start
#
# Zero-touch full bootstrap (no SSH afterwards):
#
#   curl -fsSL https://infernetprotocol.com/install.sh \\
#     | INFERNET_BEARER=$TOKEN INFERNET_MODEL=qwen2.5:7b sh
#
# Re-running this script updates an existing install in place.

set -eu

REPO_URL="https://github.com/infernetprotocol/infernet-protocol.git"
REPO_RAW_BASE="https://raw.githubusercontent.com/infernetprotocol/infernet-protocol"
DEFAULT_REF="master"
NPM_PACKAGE="@infernetprotocol/cli"

# ---------------------------------------------------------------------------
# Operator identity resolution — never assume root, never trust env alone.
# `curl | sh` invocations can land with HOME / USER unset (cron, container
# init, /etc/skel-less images). Fall back through whoami → id → getent →
# uid-based default. If we still can't determine, fail loud.
# ---------------------------------------------------------------------------
_inf_resolve_user() {
    if [ -n "${USER:-}" ]; then echo "$USER"; return 0; fi
    _u="$(whoami 2>/dev/null || id -un 2>/dev/null)"
    [ -n "$_u" ] && { echo "$_u"; return 0; }
    [ "$(id -u 2>/dev/null || echo 0)" = "0" ] && { echo "root"; return 0; }
    echo "node"
}

_inf_resolve_home() {
    # If $HOME is set and exists, trust it.
    if [ -n "${HOME:-}" ] && [ -d "$HOME" ]; then echo "$HOME"; return 0; fi
    # Look it up via getent on the resolved user.
    _u="$(_inf_resolve_user)"
    _h="$(getent passwd "$_u" 2>/dev/null | awk -F: '{print $6}')"
    if [ -n "$_h" ] && [ -d "$_h" ]; then echo "$_h"; return 0; fi
    # Last resort — uid 0 → /root, else /tmp/$user.
    if [ "$(id -u 2>/dev/null || echo 0)" = "0" ]; then echo "/root"; return 0; fi
    _h="/tmp/$_u"
    mkdir -p "$_h" 2>/dev/null || true
    echo "$_h"
}

USER="$(_inf_resolve_user)"
HOME="$(_inf_resolve_home)"
export USER HOME

INFERNET_HOME="${INFERNET_HOME:-$HOME/.infernet}"
INFERNET_BIN="${INFERNET_BIN:-$HOME/.local/bin}"
INFERNET_REF="${INFERNET_REF:-$DEFAULT_REF}"
INFERNET_NPM_VERSION="${INFERNET_NPM_VERSION:-latest}"
INFERNET_FORCE_GIT="${INFERNET_FORCE_GIT:-}"
# --force (or INFERNET_FORCE=1): wipe models + inference state from a previous,
# not-quite-working install before reinstalling — all Ollama models, the vLLM
# serve + its state, and the downloaded HF weights. Keeps the node identity so
# it stays the same registered provider (just with a clean model list).
INFERNET_FORCE="${INFERNET_FORCE:-}"
INFERNET_AUTOSTART="${INFERNET_AUTOSTART:-1}"
INFERNET_CONTROL_PLANE="${INFERNET_CONTROL_PLANE:-https://infernetprotocol.com}"
# Default model: qwen2.5:7b for GPU nodes, qwen2.5:0.5b for CPU-only.
# Operators can override via INFERNET_MODEL=<name> before running the installer.
if [ -z "${INFERNET_MODEL:-}" ]; then
    if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L 2>/dev/null | grep -q "GPU"; then
        INFERNET_MODEL="qwen2.5:7b"
    else
        INFERNET_MODEL="qwen2.5:0.5b"
    fi
fi
INFERNET_NODE_ROLE="${INFERNET_NODE_ROLE:-provider}"
# Leave INFERNET_NODE_NAME unset by default so `infernet init` can
# generate the user@host:slug default itself (it has access to nodeId,
# we don't here). Operators who want a custom name set this env var
# explicitly; otherwise auto_bootstrap_native skips passing --name.
INFERNET_NODE_NAME="${INFERNET_NODE_NAME:-}"
INFERNET_PUBLIC_PORT="${INFERNET_PUBLIC_PORT:-46337}"
INFERNET_BIND_PORT="${INFERNET_BIND_PORT:-}"
INFERNET_BEARER="${INFERNET_BEARER:-}"
SOURCE_DIR="$INFERNET_HOME/source"
WRAPPER="$INFERNET_BIN/infernet"

# ---------------------------------------------------------------------------
# Hosting-platform port-mapping detection.
#
# RunPod (and similar GPU clouds) NAT the container — internally the
# daemon listens on 46337, externally the platform maps that to a
# random port like :21517 or :43337. Without this block, the daemon
# would advertise (public_ip, 46337) which nobody can reach. With it,
# we advertise (public_ip, mapped_port) and bind locally to 46337.
#
# Variables consumed downstream:
#   INFERNET_PUBLIC_PORT  — what we advertise to the control plane
#   INFERNET_BIND_PORT    — what the daemon listens on locally
#   INFERNET_PUBLIC_ADDRESS — what we advertise (overrides icanhazip)
# ---------------------------------------------------------------------------
detect_hosting_platform_ports() {
    # RunPod sets RUNPOD_TCP_PORT_<internal>=<external> for every
    # exposed port, and RUNPOD_PUBLIC_IP for the host's edge IP.
    # POSIX sh — no `local`, prefix function-scoped vars with _ to
    # avoid clashing with the global namespace.
    if [ -n "${RUNPOD_PUBLIC_IP:-}" ]; then
        _bind_port="${INFERNET_PUBLIC_PORT:-46337}"
        _mapped_var="RUNPOD_TCP_PORT_${_bind_port}"
        _mapped="$(eval "echo \${$_mapped_var:-}")"
        if [ -n "$_mapped" ]; then
            : "${INFERNET_BIND_PORT:=$_bind_port}"
            INFERNET_PUBLIC_PORT="$_mapped"
            : "${INFERNET_PUBLIC_ADDRESS:=$RUNPOD_PUBLIC_IP}"
            export INFERNET_BIND_PORT INFERNET_PUBLIC_PORT INFERNET_PUBLIC_ADDRESS
            printf '  [hosting] RunPod detected — advertising %s:%s, daemon binds :%s\n' \
                "$INFERNET_PUBLIC_ADDRESS" "$INFERNET_PUBLIC_PORT" "$INFERNET_BIND_PORT"
        fi
        unset _bind_port _mapped_var _mapped
    fi

    # Vast.ai exposes PUBLIC_IPADDR for the host's edge IP and
    # VAST_TCP_PORT_<internal>=<external> for every port the operator
    # opened in the Vast template. If the operator forgot to open
    # 46337 we still set the public address so the CLI advertises a
    # reachable IP — even if the port can't be reached, downstream
    # clients see a non-Docker address and the bug is obvious in the
    # dashboard ("provider X listed at <real-ip>:46337") instead of
    # silently advertising a 172.17.0.4 nobody can route to.
    if [ -n "${PUBLIC_IPADDR:-}" ] || [ -n "${VAST_INSTANCE_ID:-}" ] || [ -n "${VAST_CONTAINERLABEL:-}" ]; then
        _bind_port="${INFERNET_PUBLIC_PORT:-46337}"
        _mapped_var="VAST_TCP_PORT_${_bind_port}"
        _mapped="$(eval "echo \${$_mapped_var:-}")"
        _vast_ip="${PUBLIC_IPADDR:-}"
        if [ -n "$_mapped" ]; then
            : "${INFERNET_BIND_PORT:=$_bind_port}"
            INFERNET_PUBLIC_PORT="$_mapped"
            : "${INFERNET_PUBLIC_ADDRESS:=$_vast_ip}"
            export INFERNET_BIND_PORT INFERNET_PUBLIC_PORT INFERNET_PUBLIC_ADDRESS
            printf '  [hosting] Vast.ai detected — advertising %s:%s, daemon binds :%s\n' \
                "$INFERNET_PUBLIC_ADDRESS" "$INFERNET_PUBLIC_PORT" "$INFERNET_BIND_PORT"
        elif [ -n "$_vast_ip" ]; then
            : "${INFERNET_PUBLIC_ADDRESS:=$_vast_ip}"
            export INFERNET_PUBLIC_ADDRESS
            printf '  [hosting] Vast.ai detected — public IP %s found, but port %s not exposed\n' \
                "$INFERNET_PUBLIC_ADDRESS" "$_bind_port"
            printf '            Open TCP %s in your Vast template (or set INFERNET_PUBLIC_PORT)\n' \
                "$_bind_port"
            printf '            so peers can reach this node.\n'
        fi
        unset _bind_port _mapped_var _mapped _vast_ip
    fi
    # Other platforms can be added here as they're encountered. Default
    # is the no-op case where bind and advertise are the same port.
}
detect_hosting_platform_ports || true

# ---------------------------------------------------------------------------
# Big-volume relocation (host-agnostic).
#
# Many GPU hosts have a small root filesystem (5–20 GB overlay) and a
# big persistent volume mounted somewhere else:
#   RunPod         /workspace       (or /vllm-workspace, /runpod-volume)
#   Vast.ai        /workspace       (or /data)
#   Lambda Labs    /lambda          (or /home/$user — already-big-fs case)
#   bare metal     /mnt/<whatever>  whatever the operator mounted
#
# Rather than special-case every platform, scan `df -P` for the
# writable mount with the most free space (excluding $HOME's own
# filesystem and anything virtual/system) and relocate the install
# there if it offers materially more headroom than $HOME.
#
# Relocates everything we can:
#   INFERNET_HOME   → $VOLUME/infernet      (clone + node_modules)
#   INFERNET_BIN    → $VOLUME/infernet/bin  (wrapper + mise binary)
#   MISE_DATA_DIR   → $VOLUME/mise          (node LTS)
#   OLLAMA_MODELS   → $VOLUME/ollama-models (model blobs)
#   PNPM_HOME       → $VOLUME/pnpm          (pnpm store)
#   /usr/local/lib/ollama → symlink → $VOLUME/ollama-libs (CUDA libs)
#
# The /usr/local/lib/ollama symlink is the load-bearing one: it's
# where Ollama's installer extracts the ~3 GB mlx_cuda_v13 + cudnn
# tarball. We pre-create the symlink so the extract lands on the big
# disk instead of filling up the root overlay.
#
# Opt out: set INFERNET_HOME explicitly, OR set INFERNET_NO_RELOCATE=1.
# ---------------------------------------------------------------------------
detect_install_volume() {
    [ "${INFERNET_NO_RELOCATE:-}" = "1" ] && return 0
    # If user set INFERNET_HOME explicitly, respect it.
    [ "$INFERNET_HOME" = "$HOME/.infernet" ] || return 0

    _home_mp="$(df -P "$HOME" 2>/dev/null | awk 'NR==2 {print $6}')"
    _home_kb="$(df -P "$HOME" 2>/dev/null | awk 'NR==2 {print $4}')"
    [ -n "$_home_mp" ] || return 0

    _best_mp=""
    _best_kb=0
    # Scan every mounted fs, pick the writable one with the most
    # free space that isn't $HOME's mount and isn't virtual/system.
    while read -r _fs _blocks _used _avail _capacity _mp; do
        case "$_fs" in
            tmpfs|devtmpfs|overlay|proc|sysfs|cgroup*|mqueue|securityfs|pstore|debugfs|tracefs|configfs|fusectl|none|squashfs|nsfs|hugetlbfs|binfmt_misc|autofs)
                continue ;;
        esac
        case "$_mp" in
            /|/proc|/proc/*|/sys|/sys/*|/dev|/dev/*|/run|/run/*|/boot|/boot/*|/etc|/etc/*|/usr|/usr/*|/var/lib/docker*|/snap|/snap/*|/tmp)
                continue ;;
        esac
        [ "$_mp" = "$_home_mp" ] && continue
        [ -w "$_mp" ] || continue
        # Must have at least 10 GB free to be worth relocating to.
        [ "${_avail:-0}" -lt 10485760 ] && continue
        if [ "$_avail" -gt "$_best_kb" ]; then
            _best_kb="$_avail"
            _best_mp="$_mp"
        fi
    done <<EOF
$(df -P 2>/dev/null | tail -n +2)
EOF

    [ -z "$_best_mp" ] && return 0

    # Only relocate if the volume has at least 2x more free space than
    # $HOME — guards against e.g. a 16 GB USB drive on a desktop with
    # 200 GB free at $HOME.
    if [ "$_best_kb" -lt $(( ${_home_kb:-0} * 2 )) ]; then
        return 0
    fi

    INFERNET_HOME="$_best_mp/infernet"
    INFERNET_BIN="$INFERNET_HOME/bin"
    SOURCE_DIR="$INFERNET_HOME/source"
    WRAPPER="$INFERNET_BIN/infernet"

    MISE_DATA_DIR="$_best_mp/mise"
    MISE_INSTALL_PATH="$INFERNET_BIN/mise"
    OLLAMA_MODELS="$_best_mp/ollama-models"
    PNPM_HOME="$_best_mp/pnpm"
    export MISE_DATA_DIR MISE_INSTALL_PATH OLLAMA_MODELS PNPM_HOME

    # Pre-create the Ollama lib symlink so its installer's tar extract
    # lands on the volume. Skip if /usr/local/lib/ollama already exists
    # as a directory (failed prior install — operator must clean up).
    mkdir -p "$_best_mp/ollama-libs" 2>/dev/null || true
    if [ -L /usr/local/lib/ollama ] || [ ! -e /usr/local/lib/ollama ]; then
        mkdir -p /usr/local/lib 2>/dev/null || true
        rm -f /usr/local/lib/ollama 2>/dev/null || true
        ln -sf "$_best_mp/ollama-libs" /usr/local/lib/ollama 2>/dev/null || true
    fi

    # Symlink ~/.X dirs the daemon + tooling write to — daemon config,
    # identity, daemon.log, mise's config, ollama's blobs cache, etc.
    # Each is just a symlink (a few bytes on the overlay), but the
    # writes that follow them all land on the big volume.
    relocate_dot_dir() {
        # $1 = relative path under $HOME (e.g. ".config/infernet")
        _src="$HOME/$1"
        _dst="$_best_mp/$1"
        mkdir -p "$_dst" 2>/dev/null || true
        # Make sure parent of $_src exists on the overlay.
        mkdir -p "$(dirname "$_src")" 2>/dev/null || true
        if [ -L "$_src" ] || [ ! -e "$_src" ]; then
            rm -f "$_src" 2>/dev/null || true
            ln -sf "$_dst" "$_src" 2>/dev/null || true
        elif [ -d "$_src" ] && [ -z "$(ls -A "$_src" 2>/dev/null)" ]; then
            # Empty real dir — replace with symlink.
            rmdir "$_src" 2>/dev/null && ln -sf "$_dst" "$_src" 2>/dev/null || true
        fi
        unset _src _dst
    }
    relocate_dot_dir ".config/infernet"
    # NOTE: do NOT symlink ~/.config/mise — mise canonicalizes config
    # paths when storing trust state, and a symlinked config dir
    # creates a path-resolution mismatch where `mise trust` records
    # one path and child processes look up another. The config is
    # tiny (~50 bytes), keeping it on the overlay is fine.
    relocate_dot_dir ".cache/infernet"
    relocate_dot_dir ".ollama"

    _free_g=$(( _best_kb / 1024 / 1024 ))
    _home_g=$(( ${_home_kb:-0} / 1024 / 1024 ))
    printf '  [storage] big volume at %s (%s GB free) — relocating install off $HOME (%s GB)\n' \
        "$_best_mp" "$_free_g" "$_home_g"
    printf '            INFERNET_HOME=%s\n' "$INFERNET_HOME"
    printf '            OLLAMA_MODELS=%s\n' "$OLLAMA_MODELS"
    printf '            /usr/local/lib/ollama → %s/ollama-libs\n' "$_best_mp"
    printf '            ~/.config/infernet, ~/.cache/infernet, ~/.ollama → %s/...\n' "$_best_mp"
    unset _home_mp _home_kb _best_mp _best_kb _fs _blocks _used _avail _capacity _mp _free_g _home_g
}
detect_install_volume || true

# ---------------------------------------------------------------------------
# pretty output
# ---------------------------------------------------------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
    RED=$(printf '\033[31m'); GREEN=$(printf '\033[32m')
    YELLOW=$(printf '\033[33m'); BLUE=$(printf '\033[34m'); BOLD=$(printf '\033[1m'); RESET=$(printf '\033[0m')
else
    RED=''; GREEN=''; YELLOW=''; BLUE=''; BOLD=''; RESET=''
fi

info()  { printf '%s==>%s %s\n' "$BLUE" "$RESET" "$*"; }
ok()    { printf '%s ✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn()  { printf '%s !%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }
fail()  { printf '%s ✗%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# platform detection
# ---------------------------------------------------------------------------
detect_os() {
    UNAME_S="$(uname -s)"
    case "$UNAME_S" in
        Linux)  OS=linux ;;
        Darwin) OS=macos ;;
        *)      fail "unsupported OS: $UNAME_S (Linux and macOS only)" ;;
    esac
}

# ---------------------------------------------------------------------------
# disk-space preflight
#
# Realistic disk math for a zero-touch bearer install on a CUDA box:
#   pnpm install (monorepo) ........ ~2.0 GB
#   Node LTS via mise ............... ~0.1 GB
#   Ollama base binary ............. ~1.0 GB
#   Ollama mlx_cuda_v13 libs ....... ~3.0 GB  (only on CUDA hosts)
#   Ollama vulkan libs ............. ~0.3 GB
#   Model qwen2.5:7b ............... ~4.4 GB
#   Model qwen3.5-uncensored:9b .... ~7.4 GB
#   tar-extract peak (2x of one lib) ~1.0 GB headroom
#                                    ───────
#   minimum, CUDA host + 7B model ..  ~12 GB
#   minimum, CUDA host + 9B model ..  ~15 GB
#
# Failing halfway through tar-extracting CUDA libs (or worse, a 7 GB
# model pull) is a brutal UX — bail loudly up front instead.
#
# Override:
#   INFERNET_MIN_DISK_MB=N      override threshold (defaults below)
#   INFERNET_SKIP_DISK_CHECK=1  skip the check entirely
# ---------------------------------------------------------------------------
free_mb_at() {
    _path="$1"
    [ -d "$_path" ] || _path="$(dirname "$_path")"
    # df -P prints sizes in 1K-blocks portably (linux + macOS + busybox).
    _kb="$(df -P "$_path" 2>/dev/null | awk 'NR==2 {print $4}')"
    if [ -z "$_kb" ] || [ "$_kb" = "0" ]; then
        echo 0
    else
        echo "$((_kb / 1024))"
    fi
    unset _path _kb
}

check_disk_space() {
    if [ "${INFERNET_SKIP_DISK_CHECK:-}" = "1" ]; then
        return 0
    fi
    # Default 3 GB without bearer (just the install).
    # With bearer + auto-bootstrap, the math depends on whether Ollama
    # will pull CUDA libs (~3 GB extra). Detect by presence of nvidia-smi
    # — if missing, the Ollama install path is the lighter CPU/Vulkan one.
    if [ -n "$INFERNET_BEARER" ]; then
        if command -v nvidia-smi >/dev/null 2>&1; then
            # 15 GB Ollama+CUDA + 5 GB vLLM venv + 5 GB headroom for tar peaks
            _default_need=25600   # 25 GB — Ollama+CUDA + vLLM + ~7 GB model + headroom
        else
            _default_need=10240   # 10 GB — install + Ollama (no CUDA) + model + headroom
        fi
    else
        _default_need=3072
    fi
    _need_mb="${INFERNET_MIN_DISK_MB:-$_default_need}"
    # Measure the filesystem where the install will actually land. After
    # detect_install_volume runs, INFERNET_HOME may point at a big volume
    # while $HOME is on a tiny overlay — checking $HOME would warn
    # spuriously about disk that doesn't matter for the install.
    _check_path="$INFERNET_HOME"
    [ -d "$_check_path" ] || _check_path="$(dirname "$_check_path")"
    [ -d "$_check_path" ] || _check_path="$HOME"
    _free_mb="$(free_mb_at "$_check_path")"
    # df unavailable / unknown filesystem — best-effort: don't block.
    if [ "${_free_mb:-0}" = "0" ]; then
        warn "could not check disk space at $_check_path — continuing anyway"
        unset _default_need _need_mb _free_mb _check_path
        return 0
    fi
    if [ "$_free_mb" -lt "$_need_mb" ]; then
        warn "low disk: ${_free_mb} MB free at $_check_path, need ~${_need_mb} MB"
        warn "free up space (e.g. 'pnpm store prune', 'docker system prune') and re-run."
        warn "to override: INFERNET_MIN_DISK_MB=$_free_mb or INFERNET_SKIP_DISK_CHECK=1"
        fail "insufficient disk space"
    fi
    if [ "$_free_mb" -lt $((_need_mb * 2)) ]; then
        warn "tight disk: ${_free_mb} MB free at $_check_path — recommended >$((_need_mb * 2)) MB"
    else
        ok "disk: ${_free_mb} MB free at $_check_path"
    fi
    unset _default_need _need_mb _free_mb _check_path
}

# ---------------------------------------------------------------------------
# Sudo + apt-prereq handling
#
# Container images (Docker, RunPod, K8s) usually run as root and may
# not have `sudo` installed; bare-metal / VM operators typically do.
# Resolve once so every privileged step is idempotent regardless.
# ---------------------------------------------------------------------------
if [ "$(id -u 2>/dev/null || echo 0)" = "0" ]; then
    SUDO=""
else
    if command -v sudo >/dev/null 2>&1; then
        SUDO="sudo"
    else
        SUDO=""
    fi
fi

# Idempotent: only installs missing packages. Safe to re-run any time.
ensure_apt_prereqs() {
    need_pkg() { command -v "$1" >/dev/null 2>&1; }
    _missing=""
    need_pkg curl  || _missing="$_missing curl"
    need_pkg git   || _missing="$_missing git"
    need_pkg zstd  || _missing="$_missing zstd"
    if [ -z "$_missing" ]; then
        unset _missing
        return 0
    fi
    info "installing system prereqs:$_missing"
    if command -v apt-get >/dev/null 2>&1; then
        $SUDO apt-get update -y || true
        # shellcheck disable=SC2086
        $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates $_missing
    elif command -v dnf >/dev/null 2>&1; then
        # shellcheck disable=SC2086
        $SUDO dnf install -y ca-certificates $_missing
    elif command -v yum >/dev/null 2>&1; then
        # shellcheck disable=SC2086
        $SUDO yum install -y ca-certificates $_missing
    elif command -v apk >/dev/null 2>&1; then
        # shellcheck disable=SC2086
        $SUDO apk add --no-cache ca-certificates $_missing
    else
        warn "no apt-get / dnf / yum / apk found — please install$_missing manually"
    fi
    unset _missing
}

# ---------------------------------------------------------------------------
# dependency checks
# ---------------------------------------------------------------------------
need_node_install_hint() {
    cat <<EOF

  Install Node.js (LTS) first. Easiest path on any platform:

    curl https://mise.run | sh
    ~/.local/bin/mise use --global node@24

  Then re-run this script.

EOF
}

try_install_node_unattended() {
    # Idempotent: skips if Node 18+ is already on PATH. Otherwise
    # installs Node LTS via mise (a polyglot version manager — single
    # static binary, works on linux + macOS, lives entirely under
    # $HOME so it doesn't fight any system-bundled `node` left over
    # from a base image like RunPod's vllm-workspace, which ships
    # node 12).
    if command -v node >/dev/null 2>&1; then
        _node_v="$(node -v | sed 's/^v//')"
        _node_major="$(echo "$_node_v" | cut -d. -f1)"
        if [ "${_node_major:-0}" -ge 18 ]; then
            unset _node_v _node_major
            return 0
        fi
        unset _node_v _node_major
    fi

    info "installing Node.js 24 (LTS) via mise (https://mise.jdx.dev)"
    # Resolve where mise binary will land: $MISE_INSTALL_PATH if set
    # by detect_install_volume (volume-relocation case), else default.
    _mise_bin="${MISE_INSTALL_PATH:-$HOME/.local/bin/mise}"
    # Pre-create the install dir so mise.run doesn't have to.
    mkdir -p "$(dirname "$_mise_bin")" 2>/dev/null || true
    if [ ! -x "$_mise_bin" ]; then
        # Official one-liner. Honors $MISE_INSTALL_PATH for the binary
        # location, $MISE_DATA_DIR for installed tools. Don't gag the
        # installer's output — it downloads ~30 MB and the user wants
        # to see progress, not stare at a silent terminal.
        #
        # Filter known-harmless mv warnings through awk so they read as
        # "warn:" lines instead of looking like real failures. mise.run
        # extracts to /tmp (overlay) and `mv`s to MISE_INSTALL_PATH; on
        # network filesystems (RunPod's MooseFS, NFS, SMB) the chown
        # step fails but the file copy succeeds, so the binary works
        # fine. Exit-code check is the trailing -x test on $_mise_bin.
        info "  → downloading mise binary (~30 MB) from mise.run"
        curl -fsSL https://mise.run | sh 2>&1 | awk '
            /failed to preserve ownership|cannot preserve ownership/ {
                printf "  ! warn: %s (harmless on network FS — mv across mounts)\n", $0
                next
            }
            { print }
        '
    fi
    if [ ! -x "$_mise_bin" ]; then
        # mise.run sometimes defaults differently — fall back to common spots.
        for _candidate in "$INFERNET_BIN/mise" "$HOME/.local/bin/mise" /usr/local/bin/mise; do
            if [ -x "$_candidate" ]; then _mise_bin="$_candidate"; break; fi
        done
        unset _candidate
    fi
    if [ ! -x "$_mise_bin" ]; then
        warn "mise installed but binary not found (tried $INFERNET_BIN, $HOME/.local/bin, /usr/local/bin)"
        unset _mise_bin
        return 1
    fi
    ok "mise: $_mise_bin"

    # Auto-confirm any trust prompts (non-interactive install).
    MISE_YES=1
    export MISE_YES

    # Use mise by absolute path — no PATH dependency. Stream output
    # so the user can see what's happening (Node LTS download is ~80 MB
    # and takes 30-60s on a fresh box; gagging it makes the script
    # look hung).
    info "  → installing Node.js 24 LTS (~80 MB)"
    "$_mise_bin" install node@24 || warn "mise install node@24 failed"
    "$_mise_bin" use --global node@24 || warn "mise use --global node@24 failed"

    # Trust the config we just wrote. mise refuses to read untrusted
    # config.toml files (security feature) and `mise use --global`
    # writes a fresh one — without this, every subsequent `node` /
    # `npm` invocation through mise's shim layer prints "Config files
    # are not trusted" and exits non-zero, breaking pnpm subprocess
    # scripts. Trust BOTH the symlink path and the canonical path
    # (mise canonicalizes paths internally and child processes may
    # look up either form).
    _mise_global_cfg="$HOME/.config/mise/config.toml"
    if [ -f "$_mise_global_cfg" ]; then
        "$_mise_bin" trust "$_mise_global_cfg" >/dev/null 2>&1 || true
        _mise_canon="$(readlink -f "$_mise_global_cfg" 2>/dev/null || echo "$_mise_global_cfg")"
        if [ "$_mise_canon" != "$_mise_global_cfg" ]; then
            "$_mise_bin" trust "$_mise_canon" >/dev/null 2>&1 || true
        fi
        unset _mise_canon
    fi
    # Belt-and-suspenders: allowlist parent dirs via env var so future
    # invocations don't re-trip trust. Include both possible paths.
    _mise_cfg_dirs="$HOME/.config/mise"
    if [ -L "$HOME/.config/mise" ]; then
        _mise_cfg_dirs="$_mise_cfg_dirs:$(readlink -f "$HOME/.config/mise" 2>/dev/null)"
    fi
    MISE_TRUSTED_CONFIG_PATHS="$_mise_cfg_dirs"
    export MISE_TRUSTED_CONFIG_PATHS
    unset _mise_global_cfg _mise_cfg_dirs

    # Now expose the shims so plain `node` / `npm` works for the rest
    # of the script and for the wrapper at runtime.
    _mise_data="${MISE_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/mise}"
    PATH="$(dirname "$_mise_bin"):$_mise_data/shims:$PATH"
    export PATH
    unset _mise_bin _mise_data

    command -v node >/dev/null 2>&1 && return 0
    return 1
}

check_node() {
    if ! command -v node >/dev/null 2>&1; then
        info "Node.js not found — attempting unattended install"
        try_install_node_unattended || {
            warn "could not install Node.js automatically"
            need_node_install_hint
            fail "install Node.js 18+ and re-run this script"
        }
    fi
    # `command -v node` finds the binary but it might be a broken mise
    # shim (mise had node installed, then the install dir got pruned —
    # common on ephemeral storage). Detect by running node -v and
    # checking for "not a valid shim" / non-zero exit.
    NODE_VER_OUT="$(node -v 2>&1)"
    if ! echo "$NODE_VER_OUT" | grep -q '^v[0-9]'; then
        warn "node binary present but broken: ${NODE_VER_OUT}"
        if command -v mise >/dev/null 2>&1; then
            info "trying to repair via mise reshim + reinstall…"
            mise reshim >/dev/null 2>&1 || true
            mise install node@24 >/dev/null 2>&1 || true
            mise use --global node@24 >/dev/null 2>&1 || true
            mise reshim >/dev/null 2>&1 || true
        fi
        # Re-probe; if still broken, fall through to unattended install.
        NODE_VER_OUT="$(node -v 2>&1)"
        if ! echo "$NODE_VER_OUT" | grep -q '^v[0-9]'; then
            try_install_node_unattended || {
                need_node_install_hint
                fail "node was on PATH but unrunnable (broken shim?) and reinstall failed: ${NODE_VER_OUT}"
            }
        fi
    fi
    NODE_VER="$(node -v 2>/dev/null | sed 's/^v//')"
    NODE_MAJOR="$(echo "$NODE_VER" | cut -d. -f1)"
    if [ "${NODE_MAJOR:-0}" -lt 18 ]; then
        warn "Node.js $NODE_VER detected — need 18 or later"
        try_install_node_unattended || {
            need_node_install_hint
            fail "upgrade Node.js and re-run this script"
        }
        NODE_VER="$(node -v 2>/dev/null | sed 's/^v//')"
    fi
    ok "Node.js v$NODE_VER"
}

check_git() {
    if ! command -v git >/dev/null 2>&1; then
        case "$OS" in
            macos) fail "git not found — run 'xcode-select --install' first" ;;
            linux) fail "git not found — install with your distro package manager (e.g. apt install git)" ;;
        esac
    fi
    ok "git $(git --version | awk '{print $3}')"
}

ensure_bun() {
    if command -v bun >/dev/null 2>&1; then
        ok "bun $(bun --version)"
        return 0
    fi
    if [ -x "$HOME/.bun/bin/bun" ]; then
        PATH="$HOME/.bun/bin:$PATH"; export PATH
        ok "bun $("$HOME/.bun/bin/bun" --version) (already installed)"
        return 0
    fi
    info "installing bun (preferred runtime — faster than node, no mise shims)"
    if curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1 && [ -x "$HOME/.bun/bin/bun" ]; then
        PATH="$HOME/.bun/bin:$PATH"; export PATH
        ok "bun installed → $HOME/.bun/bin/bun"
    else
        warn "bun install failed — will use node/pnpm instead"
    fi
}

ensure_pnpm() {
    if command -v pnpm >/dev/null 2>&1; then
        ok "pnpm $(pnpm -v)"
        return 0
    fi
    info "installing pnpm…"
    if command -v npm >/dev/null 2>&1; then
        npm install -g pnpm || fail "npm install -g pnpm failed"
        # If we installed node via mise, expose the freshly-installed
        # pnpm binary through mise's shim layer so it's found on PATH.
        command -v mise >/dev/null 2>&1 && mise reshim >/dev/null 2>&1 || true
        ok "pnpm $(pnpm -v) (installed via npm)"
    else
        # corepack ships with Node 16+ and can enable pnpm without npm.
        if command -v corepack >/dev/null 2>&1; then
            corepack enable pnpm || fail "corepack enable pnpm failed"
            command -v mise >/dev/null 2>&1 && mise reshim >/dev/null 2>&1 || true
            ok "pnpm enabled via corepack"
        else
            fail "neither npm nor corepack found — can't install pnpm"
        fi
    fi
}

# ---------------------------------------------------------------------------
# install / update repo
# ---------------------------------------------------------------------------
clone_or_update() {
    mkdir -p "$INFERNET_HOME"
    # Validate it's a real git repo, not just a leftover .git dir from
    # `infernet remove`. A stale dir causes `git fetch` to blow up.
    if [ -d "$SOURCE_DIR/.git" ] && git -C "$SOURCE_DIR" rev-parse --git-dir > /dev/null 2>&1; then
        info "updating existing install at $SOURCE_DIR"
        git -C "$SOURCE_DIR" fetch --depth 1 --progress origin "$INFERNET_REF" \
            || fail "git fetch failed"
        git -C "$SOURCE_DIR" reset --hard "FETCH_HEAD" \
            || fail "git reset failed"
        ok "fetched $INFERNET_REF"
    else
        if [ -d "$SOURCE_DIR" ]; then
            info "stale install detected — clearing $SOURCE_DIR and re-cloning"
            rm -rf "$SOURCE_DIR"
        fi
        info "cloning $REPO_URL to $SOURCE_DIR"
        git clone --depth 1 --branch "$INFERNET_REF" --progress "$REPO_URL" "$SOURCE_DIR" \
            || fail "git clone failed"
        ok "cloned $INFERNET_REF"
    fi
}

# ---------------------------------------------------------------------------
# GPU vendor detection + vLLM install (NVIDIA only).
#
# Ollama covers every box we care about (NVIDIA / AMD / Apple Silicon /
# CPU). vLLM only runs on NVIDIA + CUDA 12.x. When we see nvidia-smi we
# install vLLM in addition to Ollama so the operator gets the high-
# throughput option as well — auto-select picks vLLM ahead of Ollama if
# both are running (IPIP-0009).
#
# Opt-out: INFERNET_INSTALL_VLLM=0
# Force on (will fail loudly without nvidia-smi): INFERNET_INSTALL_VLLM=1
# Auto-start vllm serve <model>: set INFERNET_VLLM_MODEL=<repo/name>
# ---------------------------------------------------------------------------
detect_gpu_vendor() {
    if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then
        echo nvidia
    elif command -v rocm-smi >/dev/null 2>&1; then
        echo amd
    elif [ "$OS" = "macos" ] && system_profiler SPDisplaysDataType 2>/dev/null | grep -q "Apple"; then
        echo apple
    else
        echo none
    fi
}

try_install_vllm() {
    # Skip if explicitly disabled, or if not on NVIDIA.
    case "${INFERNET_INSTALL_VLLM:-auto}" in
        0|no|false|"") return 0 ;;
    esac
    GPU_VENDOR="$(detect_gpu_vendor)"
    if [ "$GPU_VENDOR" != "nvidia" ]; then
        if [ "${INFERNET_INSTALL_VLLM:-auto}" = "1" ] || [ "${INFERNET_INSTALL_VLLM:-auto}" = "yes" ]; then
            warn "INFERNET_INSTALL_VLLM=1 set but no NVIDIA GPU detected — vLLM is NVIDIA-only"
            return 1
        fi
        info "non-NVIDIA host ($GPU_VENDOR) — skipping vLLM (Ollama covers this hardware)"
        return 0
    fi

    info "NVIDIA GPU detected — installing vLLM alongside Ollama"
    _vllm_dir="$INFERNET_HOME/vllm-venv"

    # Need Python 3.11 in the venv. mise can install it; reuse the
    # binary we already provisioned for Node.
    _mise_bin="${MISE_INSTALL_PATH:-$HOME/.local/bin/mise}"
    if [ -x "$_mise_bin" ]; then
        info "  → installing Python 3.11 via mise"
        "$_mise_bin" install python@3.11 || warn "mise install python@3.11 failed"
        "$_mise_bin" use --global python@3.11 || warn "mise use --global python@3.11 failed"
        # Re-trust after mise rewrites config.toml.
        "$_mise_bin" trust "$HOME/.config/mise/config.toml" >/dev/null 2>&1 || true
    fi

    if ! command -v python3 >/dev/null 2>&1; then
        warn "python3 not on PATH — can't install vLLM. Set INFERNET_INSTALL_VLLM=0 to silence."
        unset _vllm_dir _mise_bin
        return 1
    fi

    info "  → creating venv at $_vllm_dir"
    if ! python3 -m venv "$_vllm_dir"; then
        warn "python3 -m venv failed — install python3-venv (apt) and re-run"
        unset _vllm_dir _mise_bin
        return 1
    fi

    # uv is dramatically faster than pip for the multi-GB vLLM install.
    info "  → installing uv (fast pip frontend) in venv"
    "$_vllm_dir/bin/pip" install --upgrade --quiet pip uv || warn "uv install failed; will fall back to pip"

    info "  → installing vLLM (~5 GB of CUDA wheels; this takes 5-15 min)"
    # ninja: FlashInfer JIT-compiles its sampling kernel at runtime and shells
    # out to `ninja` during profile_run — without it vLLM dies with
    # "FileNotFoundError: 'ninja'" after loading weights. Install it in the venv.
    if [ -x "$_vllm_dir/bin/uv" ]; then
        "$_vllm_dir/bin/uv" pip install --python "$_vllm_dir/bin/python" vllm ninja \
            || { warn "uv pip install vllm failed; trying pip"; "$_vllm_dir/bin/pip" install vllm ninja; }
    else
        "$_vllm_dir/bin/pip" install vllm ninja || { warn "pip install vllm failed"; unset _vllm_dir _mise_bin; return 1; }
    fi

    # Symlink vllm onto $INFERNET_BIN so operators can run it without
    # remembering the venv path. Same for `ray` — vLLM ships with Ray
    # as a transitive dep and uses it internally for tensor/pipeline
    # parallelism, so operators with multi-GPU rigs need ray on PATH
    # to spin up `ray start --head` / `ray start --address=...` for
    # distributed serving.
    if [ -x "$_vllm_dir/bin/vllm" ]; then
        mkdir -p "$INFERNET_BIN"
        ln -sf "$_vllm_dir/bin/vllm" "$INFERNET_BIN/vllm"
        ok "vLLM installed at $_vllm_dir/bin/vllm (linked to $INFERNET_BIN/vllm)"
    else
        warn "vllm binary missing after install — see logs above"
        unset _vllm_dir _mise_bin
        return 1
    fi
    if [ -x "$_vllm_dir/bin/ray" ]; then
        ln -sf "$_vllm_dir/bin/ray" "$INFERNET_BIN/ray"
        ok "Ray CLI linked to $INFERNET_BIN/ray (for distributed vLLM)"
    fi
    # ninja lives in the venv but vLLM/FlashInfer shell out to it by PATH name;
    # symlink it onto INFERNET_BIN (already on the daemon's PATH) so it's found
    # even when vLLM is invoked via the ~/.local/bin/vllm symlink.
    if [ -x "$_vllm_dir/bin/ninja" ]; then
        ln -sf "$_vllm_dir/bin/ninja" "$INFERNET_BIN/ninja"
        ok "ninja linked to $INFERNET_BIN/ninja (FlashInfer JIT)"
    fi

    # huggingface_hub CLI — the daemon downloads HF/vLLM model weights with it
    # (apps/cli/lib/hf-model.js probes `huggingface-cli`). vLLM pulls the lib in
    # transitively, but the CLI binary isn't on PATH, so `infernet model pull
    # hf:...` failed with "huggingface_hub not installed". Install it explicitly
    # (with hf_transfer for fast downloads) and symlink the CLI out.
    info "  → installing huggingface_hub CLI (for hf: model downloads)"
    "$_vllm_dir/bin/pip" install --quiet -U huggingface_hub hf_transfer \
        || warn "huggingface_hub install failed — hf: model pulls won't work"
    for _hf in huggingface-cli hf; do
        if [ -x "$_vllm_dir/bin/$_hf" ]; then
            ln -sf "$_vllm_dir/bin/$_hf" "$INFERNET_BIN/$_hf"
            ok "$_hf linked to $INFERNET_BIN/$_hf"
        fi
    done
    unset _hf

    # Optional: bring up a Ray cluster head or join an existing one.
    # Operators with one big GPU box leave INFERNET_RAY_MODE unset
    # (vLLM still uses Ray internally for single-node TP). Operators
    # with multi-node clusters set MODE=head on one box and MODE=worker
    # + HEAD=<head>:<port> on the others before running vllm serve.
    case "${INFERNET_RAY_MODE:-}" in
        head)
            _ray_port="${INFERNET_RAY_PORT:-6379}"
            info "  → starting Ray head on :$_ray_port"
            "$_vllm_dir/bin/ray" start --head --port="$_ray_port" \
                --dashboard-host=0.0.0.0 --dashboard-port=8265 \
                || warn "ray start --head failed"
            unset _ray_port
            ;;
        worker)
            if [ -z "${INFERNET_RAY_HEAD:-}" ]; then
                warn "INFERNET_RAY_MODE=worker but INFERNET_RAY_HEAD not set — skip"
            else
                info "  → joining Ray cluster at $INFERNET_RAY_HEAD"
                "$_vllm_dir/bin/ray" start --address="$INFERNET_RAY_HEAD" \
                    || warn "ray start --address=$INFERNET_RAY_HEAD failed"
            fi
            ;;
    esac

    # Auto-start a vllm serve daemon if INFERNET_VLLM_MODEL is set.
    if [ -n "${INFERNET_VLLM_MODEL:-}" ]; then
        info "  → starting 'vllm serve $INFERNET_VLLM_MODEL' in the background"
        _vllm_log="$INFERNET_HOME/vllm.log"
        nohup "$_vllm_dir/bin/vllm" serve "$INFERNET_VLLM_MODEL" \
            --host 0.0.0.0 --port 8000 \
            > "$_vllm_log" 2>&1 &
        printf '%d\n' $! > "$INFERNET_HOME/vllm.pid"
        ok "vllm serve started (pid $!) — logs: $_vllm_log"
        unset _vllm_log
    else
        printf '  to serve a model later: %s/vllm serve <repo/name> --host 0.0.0.0 --port 8000\n' "$INFERNET_BIN"
        printf '  or set INFERNET_VLLM_MODEL=<repo/name> and re-run this installer to auto-start.\n'
    fi

    unset _vllm_dir _mise_bin
}

# ---------------------------------------------------------------------------
# CPU baseline model — every node has a CPU, so we unconditionally pull a
# small Qwen model at install time. This guarantees that even operators
# who set INFERNET_AUTOSTART=0 (or whose `infernet setup` later fails on
# a different model) still have a working model to answer chat requests.
#
# Idempotent: `ollama pull` is a no-op if the model is already cached.
# `infernet setup --yes` runs later (when AUTOSTART=1) and pulls the
# operator-selected $INFERNET_MODEL alongside this baseline.
#
# Opt-out:  INFERNET_SKIP_CPU_BASELINE=1
# Override: INFERNET_CPU_BASELINE_MODEL=<name>  (default qwen2.5:0.5b)
# ---------------------------------------------------------------------------
ensure_cpu_baseline_model() {
    if [ "${INFERNET_SKIP_CPU_BASELINE:-0}" = "1" ]; then
        info "INFERNET_SKIP_CPU_BASELINE=1 — skipping CPU baseline model pull"
        return 0
    fi

    _cpu_model="${INFERNET_CPU_BASELINE_MODEL:-qwen2.5:0.5b}"
    info "ensuring CPU baseline model is installed: $_cpu_model"

    if ! command -v ollama >/dev/null 2>&1; then
        info "  → ollama not found — installing via the official ollama.com script"
        if ! curl -fsSL https://ollama.com/install.sh | sh; then
            warn "ollama install failed — skipping baseline model pull"
            warn "   retry later: curl -fsSL https://ollama.com/install.sh | sh"
            unset _cpu_model
            return 0
        fi
    fi

    info "  → ollama pull $_cpu_model (≈400 MB; idempotent if already cached)"
    if ollama pull "$_cpu_model"; then
        ok "CPU baseline model ready: $_cpu_model"
    else
        warn "ollama pull $_cpu_model failed — retry later: ollama pull $_cpu_model"
    fi

    unset _cpu_model
}

run_install() {
    # Prefer bun — it's fast, self-contained, and (crucially) doesn't route
    # through mise's shim layer, which breaks pnpm with "No version is set for
    # shim: pnpm" on boxes where mise's node was upgraded. The monorepo's
    # `workspaces` field lets bun resolve the @infernetprotocol/* packages.
    if command -v bun >/dev/null 2>&1; then
        info "installing dependencies with bun…"
        if (cd "$SOURCE_DIR" && bun install); then
            ok "dependencies installed (bun)"
            return 0
        fi
        warn "bun install failed — falling back to pnpm"
    fi
    info "running pnpm install (downloads ~1.5 GB of node_modules; takes 1-3 min)"
    if (cd "$SOURCE_DIR" && pnpm install --prefer-offline); then
        ok "dependencies installed (pnpm)"
        return 0
    fi
    fail "dependency install failed — bun and pnpm both unavailable/failed"
}

# ---------------------------------------------------------------------------
# bin shim
# ---------------------------------------------------------------------------
write_wrapper() {
    mkdir -p "$INFERNET_BIN"
    # Resolve install-time paths so the wrapper has them hardcoded.
    # Without this, the wrapper falls back to $HOME/.local/share/mise
    # at runtime — wrong when detect_install_volume relocated mise to
    # the volume (e.g. /workspace/mise on RunPod). Operator's shell
    # rarely has MISE_DATA_DIR set, so the fallback was actively
    # broken on every relocated install.
    _mise_data_at_install="${MISE_DATA_DIR:-$HOME/.local/share/mise}"
    _mise_cfg_at_install="$HOME/.config/mise"
    cat > "$WRAPPER" <<EOF
#!/bin/sh
# Infernet CLI shim — generated by install.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ).
# Self-contained: install-time paths are baked in so this works
# regardless of the operator's shell environment.

# mise paths — operator can override via env, otherwise we use the
# values install.sh resolved (correct even when relocated to a volume).
: "\${MISE_DATA_DIR:=$_mise_data_at_install}"
: "\${MISE_TRUSTED_CONFIG_PATHS:=$_mise_cfg_at_install}"
: "\${MISE_YES:=1}"
export MISE_DATA_DIR MISE_TRUSTED_CONFIG_PATHS MISE_YES

# Prefer bun on PATH; then mise shims (Node LTS) ahead of the rest so we
# don't pick up a stale system Node.
[ -x "\$HOME/.bun/bin/bun" ] && PATH="\$HOME/.bun/bin:\$PATH"
[ -d "\$MISE_DATA_DIR/shims" ] && PATH="\$MISE_DATA_DIR/shims:\$PATH"
export PATH

# Run on bun (preferred — fast startup), fall back to node.
if command -v bun >/dev/null 2>&1; then
    exec bun "$SOURCE_DIR/apps/cli/index.js" "\$@"
elif command -v node >/dev/null 2>&1; then
    exec node "$SOURCE_DIR/apps/cli/index.js" "\$@"
else
    printf 'infernet: neither bun nor node found on PATH\n' >&2
    printf '  re-run installer: curl -fsSL https://infernetprotocol.com/install.sh | sh\n' >&2
    exit 127
fi
EOF
    chmod +x "$WRAPPER"
    ok "wrapper installed at $WRAPPER"
    unset _mise_data_at_install _mise_cfg_at_install
}

# Try installing via npm. Returns 0 on success (binary now on PATH via
# npm's global prefix), 1 to fall back to the git clone path.
try_npm_install() {
    if ! command -v npm >/dev/null 2>&1; then
        return 1
    fi

    # Don't install a stale public npm version when this installer points at
    # newer source. Existing daemons call the live installer during release
    # self-update, so this check lets them pull the tagged source if npm
    # publishing is temporarily unavailable.
    if [ "$INFERNET_NPM_VERSION" = "latest" ] && command -v curl >/dev/null 2>&1; then
        SOURCE_CLI_VERSION="$(curl -fsSL --max-time 10 \
            "$REPO_RAW_BASE/$INFERNET_REF/apps/cli/package.json" 2>/dev/null \
            | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).version||"")}catch{}})' 2>/dev/null \
            || true)"
        NPM_CLI_VERSION="$(npm view "$NPM_PACKAGE@latest" version 2>/dev/null | tail -n 1 || true)"
        if [ -n "$SOURCE_CLI_VERSION" ] && [ -n "$NPM_CLI_VERSION" ] \
            && [ "$SOURCE_CLI_VERSION" != "$NPM_CLI_VERSION" ]; then
            warn "npm has $NPM_CLI_VERSION but source is $SOURCE_CLI_VERSION — using source install"
            return 1
        fi
    fi

    info "trying $NPM_PACKAGE@$INFERNET_NPM_VERSION via npm..."
    NPM_LOG="$(mktemp 2>/dev/null || echo "/tmp/inf-npm.$$.log")"
    if npm install -g "$NPM_PACKAGE@$INFERNET_NPM_VERSION" >"$NPM_LOG" 2>&1; then
        ok "installed via npm"
        rm -f "$NPM_LOG"
        return 0
    fi
    # 404 means the package isn't published yet — expected today, not an
    # error worth shouting about. Anything else, surface enough to debug.
    if grep -q "E404" "$NPM_LOG" 2>/dev/null; then
        warn "$NPM_PACKAGE not on npm yet — falling back to git clone"
    else
        warn "npm install failed — falling back to git clone"
        printf '  hint: %s\n' "$(tail -3 "$NPM_LOG" 2>/dev/null | head -1)"
        printf '  full log: %s\n' "$NPM_LOG"
    fi
    return 1
}

check_npm_path() {
    NPM_BIN="$(npm bin -g 2>/dev/null || npm prefix -g 2>/dev/null | sed 's|$|/bin|')"
    case ":$PATH:" in
        *":$NPM_BIN:"*)
            return 0
            ;;
    esac
    warn "$NPM_BIN is not on your PATH"
    cat <<EOF

  npm installed the binary to $NPM_BIN but that directory isn't on
  your PATH. Either add it (export PATH="$NPM_BIN:\$PATH") or use the
  full path: $NPM_BIN/infernet

EOF
}

# After a successful `npm install -g`, the binary lives at the npm
# global prefix (often /usr/local/lib/node_modules/.bin or
# ~/.npm-global/bin depending on the operator's npm config). The rest
# of the installer assumes $WRAPPER (= $INFERNET_BIN/infernet) exists,
# so symlink the npm-installed binary to $WRAPPER. Then check_path
# wires the same dirs as the git path.
link_npm_binary_to_wrapper() {
    # Refresh mise shims first — when mise IS the node provider,
    # `npm install -g` lands the binary in mise's installs/ tree but
    # mise's shim only points to it after `mise reshim` runs. Without
    # this, `infernet` either fails with "not a valid shim" (stale) or
    # we end up symlinking to a broken shim instead of the real file.
    if command -v mise >/dev/null 2>&1; then
        mise reshim >/dev/null 2>&1 || true
    fi

    # Resolve the actual installed binary, NOT the mise shim.
    # 1. Prefer `npm prefix -g`/bin/infernet — this is the real install
    #    location, even when `npm bin -g` returns a mise shims dir.
    # 2. Fall back to walking mise's installs tree directly.
    # 3. Last resort: command -v.
    NPM_PREFIX="$(npm prefix -g 2>/dev/null || true)"
    NPM_BIN="${NPM_PREFIX:+$NPM_PREFIX/bin}"
    NPM_INFERNET=""
    if [ -n "$NPM_BIN" ] && { [ -x "$NPM_BIN/infernet" ] || [ -L "$NPM_BIN/infernet" ]; }; then
        NPM_INFERNET="$NPM_BIN/infernet"
    fi
    if [ -z "$NPM_INFERNET" ]; then
        # mise installs are typically under $MISE_DATA_DIR/installs/node/<ver>/bin
        for _candidate in $(ls -1 "${MISE_DATA_DIR:-$HOME/.local/share/mise}"/installs/node/*/bin/infernet 2>/dev/null); do
            NPM_INFERNET="$_candidate"
            break
        done
    fi
    if [ -z "$NPM_INFERNET" ]; then
        NPM_INFERNET="$(command -v infernet 2>/dev/null || true)"
    fi
    if [ -z "$NPM_INFERNET" ] || { [ ! -x "$NPM_INFERNET" ] && [ ! -L "$NPM_INFERNET" ]; }; then
        warn "couldn't locate the npm-installed infernet binary (looked in $NPM_BIN)"
        warn "PATH wiring may fail — try: npm prefix -g; ls \$(npm prefix -g)/bin"
        return 1
    fi

    # Self-link guard: if the npm-installed binary IS the wrapper path,
    # nothing to write — npm already put it where we'd want it.
    if [ "$NPM_INFERNET" = "$WRAPPER" ]; then
        ok "infernet binary already at $WRAPPER (npm installed it directly)"
        return 0
    fi

    # Remove any existing $WRAPPER first (could be a stale broken
    # symlink, a stale wrapper script, or a self-loop from a prior run).
    rm -f "$WRAPPER"
    mkdir -p "$INFERNET_BIN"

    # Write a wrapper SHELL SCRIPT — not a symlink. The npm-installed
    # binary has #!/usr/bin/env node, which fails when:
    #   (a) node isn't on the user's interactive PATH, or
    #   (b) the mise `node` shim is on PATH but broken (the underlying
    #       install was pruned — common on ephemeral disks).
    # The wrapper prepends mise's REAL installs/node/<ver>/bin to PATH
    # — bypassing the shim entirely — before exec'ing. If mise has no
    # working node install, falls through to whatever else is on PATH
    # (system node, nvm, etc).
    _mise_data="${MISE_DATA_DIR:-$HOME/.local/share/mise}"
    cat > "$WRAPPER" <<WRAP_EOF
#!/bin/sh
# Auto-generated by the Infernet Protocol installer.
# Resolves a working node by skipping mise's shim layer (which can be
# broken if its underlying install was pruned) and linking directly to
# the real node binary in MISE_DATA_DIR/installs/node/<ver>/bin/.
: "\${MISE_DATA_DIR:=$_mise_data}"
for _n in "\$MISE_DATA_DIR"/installs/node/*/bin/node; do
    if [ -x "\$_n" ]; then
        PATH="\$(dirname "\$_n"):\$PATH"
        export PATH
        break
    fi
done
exec "$NPM_INFERNET" "\$@"
WRAP_EOF
    chmod +x "$WRAPPER"
    ok "wrote wrapper $WRAPPER → $NPM_INFERNET (skip-mise-shim node lookup)"
}

check_path() {
    # ALWAYS wire all three layers — early-returning when PATH appears
    # to contain $INFERNET_BIN was a real bug: install.sh adds
    # $INFERNET_BIN to its own PATH (via mise's bin dir) so that
    # `mise`, `node`, etc. resolve during install. That made check_path
    # think wiring was already done in the install.sh's process —
    # but the operator's interactive shell never had $INFERNET_BIN on
    # PATH, so `infernet: command not found` after install. Idempotent
    # operations below; safe to always run.

    # 1. Symlink onto a system bin dir that's already on the parent
    #    shell's PATH. THIS is what makes `infernet` work in the same
    #    terminal where the operator just ran `curl … | sh` — no
    #    re-source dance, no new shell. Try the standard locations in
    #    priority order; show what works and what doesn't (no silent
    #    failures — operators on Vast.ai / RunPod hit "command not
    #    found" because earlier versions of this code gagged the
    #    error).
    _systemlink=""
    for _sysbin in /usr/local/bin /usr/bin /opt/bin; do
        [ -d "$_sysbin" ] || { info "  $_sysbin: missing — skip"; continue; }
        # Try direct write first.
        if ln -sf "$WRAPPER" "$_sysbin/infernet" 2>/tmp/inf-ln-err.$$ ; then
            _systemlink="$_sysbin/infernet"
            ok "symlinked $_systemlink → $WRAPPER"
            break
        fi
        _err="$(cat /tmp/inf-ln-err.$$ 2>/dev/null)"
        rm -f /tmp/inf-ln-err.$$
        # Try with sudo if available.
        if [ -n "$SUDO" ] && $SUDO ln -sf "$WRAPPER" "$_sysbin/infernet" 2>/dev/null; then
            _systemlink="$_sysbin/infernet"
            ok "symlinked $_systemlink → $WRAPPER (via sudo)"
            break
        fi
        info "  $_sysbin: ln failed — ${_err:-permission denied}"
    done
    unset _sysbin _err

    # 2. /etc/profile.d hook — sourced by every login shell system-
    #    wide. Doesn't help THIS curl | sh session but covers every
    #    future ssh/exec/new-shell into the box.
    if [ -d /etc/profile.d ]; then
        if printf 'export PATH="%s:$PATH"\n' "$INFERNET_BIN" > /etc/profile.d/infernet.sh 2>/dev/null; then
            ok "wrote /etc/profile.d/infernet.sh"
        elif [ -n "$SUDO" ] \
            && printf 'export PATH="%s:$PATH"\n' "$INFERNET_BIN" \
                | $SUDO tee /etc/profile.d/infernet.sh >/dev/null 2>&1; then
            ok "wrote /etc/profile.d/infernet.sh (via sudo)"
        else
            info "  /etc/profile.d: write failed — skip"
        fi
    fi

    # 3. Append to common shell rc files (don't trust $SHELL — often
    #    unset during a curl | sh install). Skip files that already
    #    contain $INFERNET_BIN, AND skip files we can't write (e.g.
    #    ~/.bashrc may have been created root-owned by a prior sudo
    #    install). Pre-check writability so we don't spew shell-level
    #    "Permission denied" errors that 2>/dev/null can't suppress.
    for _rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
        if [ -e "$_rc" ] && grep -qF "$INFERNET_BIN" "$_rc" 2>/dev/null; then
            continue
        fi
        # If file exists, must be writable. If file doesn't exist, parent
        # dir must be writable (so we can create it).
        if [ -e "$_rc" ]; then
            [ -w "$_rc" ] || { info "  $_rc: not writable (try: sudo chown \$USER:\$USER $_rc) — skipping"; continue; }
        else
            [ -w "$(dirname "$_rc")" ] || continue
        fi
        if printf '\n# Added by Infernet Protocol installer\nexport PATH="%s:$PATH"\n' \
            "$INFERNET_BIN" >> "$_rc" 2>/dev/null; then
            ok "appended PATH export to $_rc"
        fi
    done
    unset _rc

    # Decide whether THIS shell will see `infernet` on the next prompt:
    # only true if we successfully created a symlink in a dir that's
    # already on PATH. /etc/profile.d and rc-file appends only kick in
    # for new shells.
    if [ -n "$_systemlink" ]; then
        printf '\n%s ✓%s `infernet` is on PATH for ALL shells (including this one).\n' \
            "$GREEN" "$RESET"
        printf '   Verify: %sinfernet status%s\n\n' "$BOLD" "$RESET"
    else
        warn "couldn't symlink onto a system bin dir (tried /usr/local/bin, /usr/bin, /opt/bin)"
        cat <<EOF

  To use 'infernet' in THIS shell session right now:

      export PATH="$INFERNET_BIN:\$PATH"
      infernet status

  Or always invoke by absolute path:

      $WRAPPER status

  Future shells will pick it up automatically (rc files + profile.d).

EOF
    fi
    unset _systemlink
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
# Native auto-bootstrap — after install completes, run `infernet setup`
# automatically (and `infernet login --token` if a bearer was provided)
# so the user never has to ssh in to finish the setup.
# ---------------------------------------------------------------------------
auto_bootstrap_native() {
    if [ "$INFERNET_AUTOSTART" = "0" ]; then
        info "INFERNET_AUTOSTART=0 — skipping setup. Run 'infernet setup' manually when ready."
        return 0
    fi

    INFERNET_CMD="$WRAPPER"
    [ -x "$INFERNET_CMD" ] || INFERNET_CMD="infernet"

    if [ -n "$INFERNET_BEARER" ]; then
        info "running infernet init + login (bearer provided)"
        export INFERNET_NONINTERACTIVE=1
        # Only pass --name when operator set INFERNET_NODE_NAME explicitly;
        # otherwise let init generate its own user@host:slug default.
        if [ -n "$INFERNET_NODE_NAME" ]; then
            "$INFERNET_CMD" init --yes \
                --role "$INFERNET_NODE_ROLE" \
                --url "$INFERNET_CONTROL_PLANE" \
                --name "$INFERNET_NODE_NAME" || warn "infernet init had issues"
        else
            "$INFERNET_CMD" init --yes \
                --role "$INFERNET_NODE_ROLE" \
                --url "$INFERNET_CONTROL_PLANE" || warn "infernet init had issues"
        fi
        "$INFERNET_CMD" login --token "$INFERNET_BEARER" || warn "infernet login --token failed"
    fi

    info "running infernet setup --yes (this takes a few minutes the first time)"
    export INFERNET_NONINTERACTIVE=1
    # On --force we deliberately DON'T re-pull an Ollama starter model — the
    # operator wanted a clean slate to push vLLM models from the UI. Otherwise
    # setup pulls $INFERNET_MODEL as before.
    if [ -n "$INFERNET_FORCE" ]; then
        "$INFERNET_CMD" setup --yes --skip-pull --port "$INFERNET_PUBLIC_PORT" \
            || warn "infernet setup exited with errors — re-run 'infernet setup' to retry"
    else
        "$INFERNET_CMD" setup --yes --model "$INFERNET_MODEL" --port "$INFERNET_PUBLIC_PORT" \
            || warn "infernet setup exited with errors — re-run 'infernet setup' to retry"
    fi
}

# Wipe models + inference state left by a previous install. Preserves the node
# identity (config.json / keypair) so the dashboard keeps the same provider —
# it just re-advertises an empty model list on the next heartbeat.
force_wipe() {
    warn "--force: wiping models + inference state from previous install(s)"
    _cfg="$HOME/.config/infernet"

    # 1. Stop the daemon so it isn't advertising stale served_models.
    if [ -x "$WRAPPER" ]; then "$WRAPPER" stop >/dev/null 2>&1 || true; fi
    if [ -f "$_cfg/daemon.pid" ]; then
        _dp="$(cat "$_cfg/daemon.pid" 2>/dev/null || true)"
        [ -n "$_dp" ] && kill "$_dp" 2>/dev/null || true
    fi

    # 2. Stop any vLLM serve + clear its state/log.
    pkill -f "vllm serve" 2>/dev/null || true
    rm -f "$_cfg/vllm.json" "$_cfg/vllm.log" 2>/dev/null || true

    # 3. Remove ALL Ollama models (via the daemon if up, else nuke the store).
    if command -v ollama >/dev/null 2>&1; then
        ollama list 2>/dev/null | awk 'NR>1 && $1 != "" {print $1}' | while IFS= read -r _m; do
            [ -n "$_m" ] && ollama rm "$_m" >/dev/null 2>&1 || true
        done
    fi
    rm -rf "$HOME/.ollama/models" 2>/dev/null || true

    # 4. Clear downloaded HuggingFace weights (the vLLM model cache).
    rm -rf "$HOME/.cache/huggingface/hub" 2>/dev/null || true

    ok "--force: cleared all Ollama models, vLLM serve/state, and HF weights"
    unset _cfg _dp _m
}

main() {
    # Flag parsing — the script is usually piped (curl | sh -s -- --force).
    for _arg in "$@"; do
        case "$_arg" in
            --force) INFERNET_FORCE=1 ;;
            *) : ;;
        esac
    done
    unset _arg

    printf '\n'
    printf '%sInfernet Protocol installer%s\n' "$BOLD" "$RESET"
    printf '  user:        %s (uid=%s)\n' "$USER" "$(id -u 2>/dev/null || echo ?)"
    printf '  home:        %s\n' "$HOME"
    printf '  install dir: %s\n' "$INFERNET_HOME"
    printf '  bin dir:     %s\n' "$INFERNET_BIN"
    printf '  ref:         %s\n' "$INFERNET_REF"
    printf '\n'

    detect_os
    ok "OS: $OS"

    # --force: clear a previous, not-quite-working install's models + state
    # before we reinstall. Ollama is present from that prior install, so this
    # runs before we touch anything else.
    if [ -n "$INFERNET_FORCE" ]; then
        force_wipe
    fi

    # Bail early if there isn't enough headroom to finish the install
    # (and pull the model, if INFERNET_BEARER is set so auto-bootstrap
    # will run setup afterwards).
    check_disk_space

    # Idempotent — only installs missing packages. Cheap to call.
    ensure_apt_prereqs

    check_node
    # bun is the preferred runtime + dep installer (node stays as fallback).
    ensure_bun

    if [ -z "$INFERNET_FORCE_GIT" ] && try_npm_install; then
        # npm dropped the binary at $(npm prefix -g)/bin/infernet. Symlink
        # it to $WRAPPER so the path our messaging promises actually
        # exists, then run the same PATH-wiring as the git path so
        # /usr/local/bin/infernet + ~/.bashrc + /etc/profile.d are all set.
        link_npm_binary_to_wrapper
        check_path
        used_npm=1
    else
        check_git
        # Only set up pnpm if bun isn't available — run_install prefers bun,
        # and probing the (possibly broken) mise pnpm shim just spews scary
        # "No version is set for shim: pnpm" / node@20 noise.
        command -v bun >/dev/null 2>&1 || ensure_pnpm
        clone_or_update
        run_install
        write_wrapper
        check_path
        used_npm=0
    fi

    # On NVIDIA hosts, also install vLLM so the operator gets the
    # high-throughput engine alongside Ollama. Skipped on AMD / Apple
    # Silicon / CPU. Opt-out: INFERNET_INSTALL_VLLM=0.
    try_install_vllm || warn "vLLM install hit issues — continuing with Ollama only"

    # Every node has a CPU, so unconditionally guarantee a small Qwen
    # CPU model is available locally. Runs even when AUTOSTART=0 so
    # operators who skip `infernet setup` still have a working model.
    # Opt-out: INFERNET_SKIP_CPU_BASELINE=1.
    ensure_cpu_baseline_model

    printf '\n%sInstall complete.%s\n' "$GREEN" "$RESET"

    auto_bootstrap_native

    # ---- Final verification — will `infernet` work from a FRESH shell? ----
    # `command -v infernet` against this script's own $PATH is unreliable:
    # install.sh added $INFERNET_BIN to its PATH so mise/pnpm/etc. would
    # resolve, but the operator's interactive shell doesn't inherit that.
    # Verify by checking the actual disk locations a normal shell would
    # find — a symlink in one of /usr/local/bin, /usr/bin, /opt/bin.
    printf '\n'
    _system_link=""
    for _sysbin in /usr/local/bin /usr/bin /opt/bin; do
        if [ -e "$_sysbin/infernet" ] || [ -L "$_sysbin/infernet" ]; then
            _system_link="$_sysbin/infernet"
            break
        fi
    done
    if [ -n "$_system_link" ]; then
        ok "verified: 'infernet' is symlinked at $_system_link"
        printf '   It will work in this shell and every future shell.\n'
    else
        warn "'infernet' is NOT on a system PATH dir — for THIS shell run:"
        printf '\n      %sexport PATH="%s:$PATH" && infernet status%s\n' "$BOLD" "$INFERNET_BIN" "$RESET"
        printf '      %s%s status%s\n\n' "$BOLD" "$WRAPPER" "$RESET"
    fi
    unset _sysbin _system_link

    printf '\nUse:\n'
    printf '  infernet status       # daemon state\n'
    printf '  infernet chat "hi"    # local + P2P inference\n'
    printf '  infernet debug        # diagnostic bundle for support\n'
    printf '  infernet help         # full command list\n'
    printf '\nAbsolute path (always works):  %s\n' "$WRAPPER"
    printf 'To update later, just re-run this installer.\n'
    if [ "$used_npm" = "1" ]; then
        printf 'To uninstall:    npm uninstall -g %s\n\n' "$NPM_PACKAGE"
    else
        printf 'To uninstall:    rm -rf %s && rm -f %s\n\n' "$INFERNET_HOME" "$WRAPPER"
    fi
}

main "$@"
