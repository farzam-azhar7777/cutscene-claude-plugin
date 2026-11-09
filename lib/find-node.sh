# Finds a Node.js 18 or newer for bin/cutscene and bin/cutscene-facts (POSIX
# sh, also Git Bash). Prints its path, or nothing and returns 1.
#
# Order: CUTSCENE_NODE, then `node` on PATH (it can be a version-manager shim
# that has no version for this folder), then the newest install found from
# asdf, nvm, volta, fnm, mise or Homebrew.

cutscene_node_major() {
  # Prints the major version of the node at $1 when it runs.
  [ -n "$1" ] && [ -x "$1" ] || return 1
  cutscene_major=$("$1" -e 'process.stdout.write(String(process.versions.node.split(".")[0]))' 2>/dev/null) || return 1
  case $cutscene_major in '' | *[!0-9]*) return 1 ;; esac
  printf '%s\n' "$cutscene_major"
}

cutscene_find_node() {
  if [ -n "${CUTSCENE_NODE:-}" ]; then
    cutscene_m=$(cutscene_node_major "$CUTSCENE_NODE") && [ "$cutscene_m" -ge 18 ] && { printf '%s\n' "$CUTSCENE_NODE"; return 0; }
  fi
  cutscene_on_path=$(command -v node 2>/dev/null)
  if [ -n "$cutscene_on_path" ]; then
    cutscene_m=$(cutscene_node_major "$cutscene_on_path") && [ "$cutscene_m" -ge 18 ] && { printf '%s\n' "$cutscene_on_path"; return 0; }
  fi
  cutscene_best=""
  cutscene_best_major=0
  for cutscene_candidate in \
    "${ASDF_DATA_DIR:-$HOME/.asdf}"/installs/nodejs/*/bin/node \
    "${NVM_DIR:-$HOME/.nvm}"/versions/node/*/bin/node \
    "${VOLTA_HOME:-$HOME/.volta}"/tools/image/node/*/bin/node \
    "${FNM_DIR:-$HOME/.local/share/fnm}"/node-versions/*/installation/bin/node \
    "$HOME/Library/Application Support/fnm/node-versions"/*/installation/bin/node \
    "${MISE_DATA_DIR:-$HOME/.local/share/mise}"/installs/node/*/bin/node \
    /opt/homebrew/bin/node /usr/local/bin/node /opt/homebrew/opt/node@*/bin/node /usr/local/opt/node@*/bin/node /usr/bin/node; do
    [ -x "$cutscene_candidate" ] || continue
    # The version is in the folder name for version managers ("24.18.1",
    # "v24.18.1", "node@22"); run the others to ask.
    cutscene_version=${cutscene_candidate%/bin/node}
    cutscene_version=${cutscene_version%/installation}
    cutscene_version=${cutscene_version##*/}
    cutscene_version=${cutscene_version#v}
    cutscene_version=${cutscene_version#node@}
    cutscene_m=${cutscene_version%%.*}
    case $cutscene_m in
      '' | *[!0-9]*) cutscene_m=$(cutscene_node_major "$cutscene_candidate") || continue ;;
    esac
    if [ "$cutscene_m" -gt "$cutscene_best_major" ]; then
      cutscene_best=$cutscene_candidate
      cutscene_best_major=$cutscene_m
    fi
  done
  [ "$cutscene_best_major" -ge 18 ] || return 1
  cutscene_m=$(cutscene_node_major "$cutscene_best") && [ "$cutscene_m" -ge 18 ] || return 1
  printf '%s\n' "$cutscene_best"
}
