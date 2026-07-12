#!/bin/sh
# install.sh — one-line bootstrap for Mavericks (T-358).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/yahor-punko/mavericks-os/main/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/yahor-punko/mavericks-os/main/install.sh | sh -s -- --yes
#
# Pure POSIX sh — no bashisms, no arrays, no `[[ ]]`, no `readlink -f`.
# Verified against macOS /bin/sh and Linux dash. Windows is out of scope.
#
# This script is an MVP stand-in for a future `npx mavericks-os init` CLI.
# Intended correspondence to the deferred npm CLI:
#   install.sh                       ≈  npx mavericks-os init
#   "$target/scripts/mavp-operator" --demo  ≈  npx mavericks-os demo
#
# Flags:
#   --dir <path>       Target install directory (default: ${MAVERICKS_HOME:-$HOME/.mavericks})
#   --yes              Skip the interactive consent prompt (required for non-TTY runs)
#   --demo             Force-run the demo after install, even on a non-TTY
#   --no-demo          Skip the "run the demo now?" step entirely
#   --ref <branch/tag> Clone/checkout a specific branch or tag (default: repo default branch)
#
# Env:
#   MAVERICKS_HOME     Same effect as --dir; --dir takes precedence if both are set.

set -eu

REPO_URL="https://github.com/yahor-punko/mavericks-os.git"

TARGET_DIR="${MAVERICKS_HOME:-$HOME/.mavericks}"
ASSUME_YES=0
DEMO_MODE="ask"
REF=""

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --dir)
      shift
      if [ $# -eq 0 ]; then
        echo "ERROR: --dir requires a path argument" >&2
        exit 1
      fi
      TARGET_DIR="$1"
      ;;
    --yes)
      ASSUME_YES=1
      ;;
    --demo)
      DEMO_MODE="force"
      ;;
    --no-demo)
      DEMO_MODE="skip"
      ;;
    --ref)
      shift
      if [ $# -eq 0 ]; then
        echo "ERROR: --ref requires a branch or tag argument" >&2
        exit 1
      fi
      REF="$1"
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      echo "Usage: install.sh [--dir <path>] [--yes] [--demo|--no-demo] [--ref <branch/tag>]" >&2
      exit 1
      ;;
  esac
  shift
done

# ---------------------------------------------------------------------------
# Validate --ref BEFORE it is ever passed to git. A value starting with '-'
# would be parsed by git as an option (e.g. --upload-pack=<cmd> on file
# transports), and unrestricted characters can smuggle option-like tokens
# through argument splitting. Reject anything outside a safe ref-name
# character class instead of relying on '--' (which breaks `git checkout`
# semantics for branch/tag names).
# ---------------------------------------------------------------------------
validate_ref() {
  _ref="$1"
  case "$_ref" in
    -*)
      echo "ERROR: invalid --ref value: $_ref (must not start with '-')" >&2
      exit 1
      ;;
  esac
  case "$_ref" in
    *[!A-Za-z0-9._/-]*)
      echo "ERROR: invalid --ref value: $_ref (allowed characters: letters, digits, '.', '_', '/', '-')" >&2
      exit 1
      ;;
  esac
}

if [ -n "$REF" ]; then
  validate_ref "$REF"
fi

# ---------------------------------------------------------------------------
# TTY helpers — used by the consent gate and the demo prompt.
#
# Under `curl -fsSL <url> | sh`, stdin is the piped script body, so
# `[ -t 0 ]` is false even when the invoking shell has a controlling
# terminal a human could interact with. have_tty() additionally probes
# whether /dev/tty can be opened — this is true exactly when there is a
# controlling terminal, independent of what stdin is wired to. read_tty()
# prompts on the terminal directly in that case so the answer isn't read
# from stdin (which would otherwise consume piped script text).
# ---------------------------------------------------------------------------

# Can we prompt a human? True if stdin is a TTY, or /dev/tty is openable
# (piped `curl | sh` launched from an interactive terminal).
have_tty() {
  [ -t 0 ] && return 0
  ( : </dev/tty ) 2>/dev/null
}

# read_tty <prompt> — prompt via the controlling terminal; sets TTY_ANSWER.
read_tty() {
  if [ -t 0 ]; then
    printf '%s' "$1"
    read -r TTY_ANSWER
  else
    printf '%s' "$1" >/dev/tty
    read -r TTY_ANSWER </dev/tty
  fi
}

echo "=================================================================="
echo " Mavericks bootstrap installer"
echo " Source: $REPO_URL"
echo "=================================================================="
echo

# ---------------------------------------------------------------------------
# Step 1: Preflight — required tools
# ---------------------------------------------------------------------------
if ! command -v git >/dev/null 2>&1; then
  echo "ERROR: git is required but was not found on PATH." >&2
  echo "Install git (e.g. 'brew install git' on macOS, 'apt install git' on Debian/Ubuntu) and re-run this script." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node (Node.js) is required but was not found on PATH." >&2
  echo "Install Node.js 18+ from https://nodejs.org/ (or via nvm/brew) and re-run this script." >&2
  exit 1
fi

NODE_VERSION_RAW=$(node -v)
# node -v prints e.g. "v18.19.0" — strip leading "v", take major component.
NODE_VERSION_NUM=$(echo "$NODE_VERSION_RAW" | sed 's/^v//')
NODE_MAJOR=$(echo "$NODE_VERSION_NUM" | cut -d. -f1)

case "$NODE_MAJOR" in
  ''|*[!0-9]*)
    echo "ERROR: could not parse Node.js version from '$NODE_VERSION_RAW'." >&2
    exit 1
    ;;
esac

if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "ERROR: Node.js 18+ is required (found $NODE_VERSION_RAW)." >&2
  echo "Upgrade Node.js (e.g. via nvm: 'nvm install 18') and re-run this script." >&2
  exit 1
fi

echo "Preflight OK — git found, node $NODE_VERSION_RAW (>= 18)."
echo

# ---------------------------------------------------------------------------
# Step 2: Security consent gate (mirrors SECURITY.md)
# ---------------------------------------------------------------------------
print_disclosure() {
  echo "------------------------------------------------------------------"
  echo " Before you continue: this framework ships with autonomous tool"
  echo " execution enabled by default."
  echo
  echo " Mavericks' committed .claude/settings.json sets:"
  echo
  echo '   { "permissions": { "defaultMode": "bypassPermissions" } }'
  echo
  echo " bypassPermissions is the most permissive Claude Code permission"
  echo " mode. It suppresses the interactive approval prompt for EVERY"
  echo " tool call — file edits, Bash commands (including destructive"
  echo " ones), and network access all proceed without asking you first."
  echo " Opening a bootstrapped project in Claude Code and starting a"
  echo " session means agents will read, write, and execute across your"
  echo " filesystem and shell without a per-action confirmation dialog."
  echo
  echo " This is a deliberate framework default, not an oversight — see"
  echo " SECURITY.md in the cloned repository for the full rationale."
  echo
  echo " The single remaining human checkpoint under this mode is the"
  echo " mandatory pre-push results review enforced by --close-session —"
  echo " there is no other approval gate between an agent's actions and"
  echo " their effect."
  echo
  echo " To opt out: after install, create/edit .claude/settings.local.json"
  echo " in your project and set permissions.defaultMode to one of"
  echo " \"default\", \"plan\", \"acceptEdits\", or \"dontAsk\". See SECURITY.md"
  echo " ('How to opt out') for details."
  echo "------------------------------------------------------------------"
}

if [ "$ASSUME_YES" -eq 1 ]; then
  print_disclosure
  echo
  echo "Proceeding (--yes supplied)."
  echo
elif have_tty; then
  print_disclosure
  echo
  read_tty "Type 'y' to continue and clone Mavericks: "
  CONSENT="$TTY_ANSWER"
  case "$CONSENT" in
    y|Y|yes|YES)
      echo
      ;;
    *)
      echo "Aborted — consent not given. No files were cloned." >&2
      exit 1
      ;;
  esac
else
  print_disclosure
  echo
  echo "No TTY detected and --yes was not supplied — exiting WITHOUT cloning." >&2
  echo "Re-run with --yes to accept and proceed non-interactively, e.g.:" >&2
  echo "  curl -fsSL <installer-url> | sh -s -- --yes" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Step 3: Resolve target directory (must happen after consent, before clone)
# ---------------------------------------------------------------------------
# Resolve to an absolute path without readlink -f (not POSIX). If the path
# already exists, cd into it and use pwd; otherwise resolve the parent dir
# and append the leaf name.
resolve_abs_path() {
  _p="$1"
  if [ -d "$_p" ]; then
    (cd "$_p" && pwd)
  else
    _parent=$(dirname "$_p")
    _leaf=$(basename "$_p")
    mkdir -p "$_parent"
    _abs_parent=$(cd "$_parent" && pwd)
    echo "$_abs_parent/$_leaf"
  fi
}

TARGET_DIR=$(resolve_abs_path "$TARGET_DIR")

echo "Target directory: $TARGET_DIR"
echo

# ---------------------------------------------------------------------------
# Step 4: Idempotent clone/update
# ---------------------------------------------------------------------------
if [ -d "$TARGET_DIR/.git" ]; then
  # TOCTOU guard: an existing dir is only trusted as a prior Mavericks
  # install if its origin remote matches our hardcoded REPO_URL. Without
  # this, a pre-planted .git (e.g. at a predictable /tmp path on a shared
  # host) with malicious hooks would have `git pull`/`git merge` run those
  # hooks under the invoking user.
  EXISTING_ORIGIN=$(git -C "$TARGET_DIR" remote get-url origin 2>/dev/null) || EXISTING_ORIGIN=""
  if [ "$EXISTING_ORIGIN" != "$REPO_URL" ]; then
    echo "ERROR: existing directory at $TARGET_DIR has a git checkout whose" >&2
    echo "origin ('${EXISTING_ORIGIN:-none}') does not match the expected" >&2
    echo "Mavericks source ('$REPO_URL')." >&2
    echo "Refusing to treat it as a prior install (updating it could run" >&2
    echo "untrusted git hooks). Choose a different --dir or remove the" >&2
    echo "existing directory and re-run." >&2
    exit 1
  fi

  _parent_dir=$(dirname "$TARGET_DIR")
  if [ -d "$_parent_dir" ] && find "$_parent_dir" -maxdepth 0 -perm -0002 >/dev/null 2>&1; then
    echo "WARNING: $_parent_dir is world-writable — installing here may be" >&2
    echo "unsafe on a shared system (other local users could pre-plant" >&2
    echo "files at this path)." >&2
  fi

  echo "Existing git checkout found at $TARGET_DIR — updating (git pull --ff-only)..."
  if [ -n "$REF" ]; then
    if ! (cd "$TARGET_DIR" && git fetch --depth 1 origin "$REF" && git checkout "$REF" && git merge --ff-only "origin/$REF"); then
      echo "ERROR: failed to fetch/checkout/merge ref '$REF' in $TARGET_DIR." >&2
      echo "Aborting rather than silently falling back to a different ref." >&2
      exit 1
    fi
  fi
  (cd "$TARGET_DIR" && git pull --ff-only)
else
  echo "Cloning $REPO_URL into $TARGET_DIR ..."
  if [ -n "$REF" ]; then
    git clone --depth 1 --branch "$REF" "$REPO_URL" "$TARGET_DIR"
  else
    git clone --depth 1 "$REPO_URL" "$TARGET_DIR"
  fi
fi

echo
echo "Mavericks is installed at: $TARGET_DIR"
echo

# ---------------------------------------------------------------------------
# Step 5: Print environment export lines (do NOT edit the user's shell rc)
# ---------------------------------------------------------------------------
# Bootstrapped wrappers/hooks (scripts/mavp-operator, .claude/hooks/pre-commit)
# resolve MAVERICKS_HOME with a fallback chain: $MAVERICKS_HOME if set, else
# $HOME/.mavericks, else the legacy $HOME/Documents/mavericks. A default
# install (this script's own default target dir) already lands on the first
# fallback, so no export is required for it to keep working in a fresh shell.
DEFAULT_TARGET_DIR="$HOME/.mavericks"
LEGACY_TARGET_DIR="$HOME/Documents/mavericks"

echo "------------------------------------------------------------------"
if [ "$TARGET_DIR" = "$DEFAULT_TARGET_DIR" ] || [ "$TARGET_DIR" = "$LEGACY_TARGET_DIR" ]; then
  echo "Installed at the default location ($TARGET_DIR)."
  echo
  echo "No MAVERICKS_HOME export is needed: bootstrapped projects' scripts/"
  echo "mavp-operator wrapper and .claude/hooks/pre-commit already fall back"
  echo "to \$HOME/.mavericks (and the legacy \$HOME/Documents/mavericks) when"
  echo "MAVERICKS_HOME is unset, so this install works in a fresh shell"
  echo "without any further setup."
  echo
  echo "Optional: add \"$TARGET_DIR/scripts\" to your PATH if you want to run"
  echo "mavp-operator directly by name instead of via its full path:"
  echo
  echo "  export PATH=\"$TARGET_DIR/scripts:\$PATH\""
else
  echo "Installed at a custom location ($TARGET_DIR)."
  echo
  echo "Because this is not the default (\$HOME/.mavericks) or legacy"
  echo "(\$HOME/Documents/mavericks) location, add the following to your"
  echo "current shell session so bootstrapped projects can find it:"
  echo
  echo "  export MAVERICKS_HOME=\"$TARGET_DIR\""
  echo "  export PATH=\"\$MAVERICKS_HOME/scripts:\$PATH\""
  echo
  echo "IMPORTANT: these exports only apply to your CURRENT shell. To make"
  echo "them permanent, append the two lines above to your shell profile"
  echo "(~/.bashrc, ~/.zshrc, ~/.profile, etc.) and restart your shell or"
  echo "run 'source' on that file."
fi
echo "------------------------------------------------------------------"
echo

# ---------------------------------------------------------------------------
# Step 6: Optionally run the demo
# ---------------------------------------------------------------------------
run_demo() {
  echo
  echo "Running demo: \"$TARGET_DIR/scripts/mavp-operator\" --demo"
  "$TARGET_DIR/scripts/mavp-operator" --demo
}

case "$DEMO_MODE" in
  force)
    run_demo
    ;;
  skip)
    ;;
  ask)
    if have_tty; then
      read_tty "Run the demo now? [Y/n] "
      DEMO_ANSWER="$TTY_ANSWER"
      case "$DEMO_ANSWER" in
        n|N|no|NO)
          ;;
        *)
          run_demo
          ;;
      esac
    fi
    ;;
esac

echo
echo "Done."
