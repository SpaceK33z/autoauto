#!/usr/bin/env bash

# Mock Docker CLI for AutoAuto E2E tests.
# Simulates Docker commands using the local filesystem.
# Requires: DOCKER_MOCK_DIR env var pointing to a writable state directory.
#
# Each container gets a directory: $DOCKER_MOCK_DIR/containers/<name>/
#   rootfs/    — simulated container filesystem
#   status     — "running" or "stopped"
#   exitcode   — exit code (integer)
#   id         — 64-char hex container ID
#   labels     — one label per line
#   env        — one KEY=VALUE per line
#
# ID mappings: $DOCKER_MOCK_DIR/ids/<id> → container name
# Control:     $DOCKER_MOCK_DIR/.no-daemon — if exists, `docker info` fails
#              $DOCKER_MOCK_DIR/.fail-run  — if exists, `docker run` fails

if [ -z "${DOCKER_MOCK_DIR:-}" ]; then
  echo "DOCKER_MOCK_DIR not set" >&2
  exit 1
fi

# Resolve a container reference (short ID, full ID, or name) to its name.
resolve_container() {
  local ref="$1"
  if [ -f "$DOCKER_MOCK_DIR/ids/$ref" ]; then
    cat "$DOCKER_MOCK_DIR/ids/$ref"
    return 0
  fi
  if [ -d "$DOCKER_MOCK_DIR/containers/$ref" ]; then
    echo "$ref"
    return 0
  fi
  return 1
}

cmd="${1:-}"
shift 2>/dev/null || true

case "$cmd" in

# ---------------------------------------------------------------------------
# docker info
# ---------------------------------------------------------------------------
info)
  if [ -f "$DOCKER_MOCK_DIR/.no-daemon" ]; then
    echo "Cannot connect to the Docker daemon" >&2
    exit 1
  fi
  echo "Server Version: mock"
  exit 0
  ;;

# ---------------------------------------------------------------------------
# docker image inspect — always succeed (pretend image exists)
# ---------------------------------------------------------------------------
image)
  exit 0
  ;;

# ---------------------------------------------------------------------------
# docker build — consume stdin (Dockerfile), report success
# ---------------------------------------------------------------------------
build)
  cat >/dev/null
  echo "sha256:mockimage"
  exit 0
  ;;

# ---------------------------------------------------------------------------
# docker run -d --name NAME [--label K=V]... [--env K=V]... IMAGE CMD...
# ---------------------------------------------------------------------------
run)
  name=""
  labels=()
  envs=()
  while [ $# -gt 0 ]; do
    case "$1" in
      -d) shift ;;
      --name) name="$2"; shift 2 ;;
      --label) labels+=("$2"); shift 2 ;;
      --env) envs+=("$2"); shift 2 ;;
      *) break ;;  # image + command
    esac
  done
  [ -z "$name" ] && name="mock-$$"

  if [ -f "$DOCKER_MOCK_DIR/.fail-run" ]; then
    echo "Error: forced failure" >&2
    exit 1
  fi

  # Create container state
  cdir="$DOCKER_MOCK_DIR/containers/$name"
  mkdir -p "$cdir/rootfs"
  echo "running" > "$cdir/status"
  echo "0" > "$cdir/exitcode"

  # Store labels
  if [ ${#labels[@]} -gt 0 ]; then
    printf '%s\n' "${labels[@]}" > "$cdir/labels"
  fi

  # Store env vars
  if [ ${#envs[@]} -gt 0 ]; then
    printf '%s\n' "${envs[@]}" > "$cdir/env"
  fi

  # Generate a unique 64-char hex container ID from a counter (zero-padded for unique short IDs)
  counter=$(($(cat "$DOCKER_MOCK_DIR/.counter" 2>/dev/null || echo 0) + 1))
  echo "$counter" > "$DOCKER_MOCK_DIR/.counter"
  short_id="$(printf '%012x' "$counter")"
  container_id="${short_id}$(printf '%052x' "$counter")"

  # Store ID → name mappings (both short 12-char and full 64-char)
  mkdir -p "$DOCKER_MOCK_DIR/ids"
  echo "$name" > "$DOCKER_MOCK_DIR/ids/$short_id"
  echo "$name" > "$DOCKER_MOCK_DIR/ids/$container_id"
  echo "$container_id" > "$cdir/id"

  echo "$container_id"
  exit 0
  ;;

# ---------------------------------------------------------------------------
# docker exec [--workdir DIR] [--env K=V]... CONTAINER CMD [ARG...]
# ---------------------------------------------------------------------------
exec)
  workdir=""
  envvars=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --workdir) workdir="$2"; shift 2 ;;
      --env) envvars+=("$2"); shift 2 ;;
      *) container_ref="$1"; shift; break ;;
    esac
  done

  container_name=$(resolve_container "$container_ref") || {
    echo "Error: No such container: $container_ref" >&2
    exit 1
  }

  rootfs="$DOCKER_MOCK_DIR/containers/$container_name/rootfs"

  if [ -n "$workdir" ]; then
    exec_cwd="$rootfs$workdir"
  else
    exec_cwd="$rootfs"
  fi
  mkdir -p "$exec_cwd"

  # Load container-level env from `docker run --env`
  if [ -f "$DOCKER_MOCK_DIR/containers/$container_name/env" ]; then
    while IFS= read -r ev; do
      [ -n "$ev" ] || continue
      export "$ev"
    done < "$DOCKER_MOCK_DIR/containers/$container_name/env"
  fi

  # Apply per-exec overrides from `docker exec --env`
  if [ ${#envvars[@]} -gt 0 ]; then
    for ev in "${envvars[@]}"; do
      export "$ev"
    done
  fi

  cmd_name="$1"; shift

  case "$cmd_name" in
    cat)
      # Rewrite absolute paths to rootfs-relative
      file="$1"
      if [[ "$file" == /* ]]; then
        real_file="$rootfs$file"
      else
        real_file="$exec_cwd/$file"
      fi
      if [ -f "$real_file" ]; then
        cat "$real_file"
        exit 0
      else
        echo "cat: $1: No such file or directory" >&2
        exit 1
      fi
      ;;
    mkdir)
      # Skip flags (-p etc), handle the path argument
      while [[ "${1:-}" == -* ]]; do shift; done
      dir="$1"
      if [[ "$dir" == /* ]]; then
        mkdir -p "$rootfs$dir"
      else
        mkdir -p "$exec_cwd/$dir"
      fi
      exit 0
      ;;
    *)
      # General command: run in exec_cwd
      cd "$exec_cwd"
      "$cmd_name" "$@"
      exit $?
      ;;
  esac
  ;;

# ---------------------------------------------------------------------------
# docker cp SRC CONTAINER:DEST  (host → container)
# docker cp CONTAINER:SRC DEST  (container → host, not implemented)
# ---------------------------------------------------------------------------
cp)
  src="$1"
  dest="$2"

  if [[ "$dest" == *:* ]]; then
    # Host → Container
    container_ref="${dest%%:*}"
    remote_path="${dest#*:}"

    container_name=$(resolve_container "$container_ref") || {
      echo "Error: No such container: $container_ref" >&2
      exit 1
    }

    rootfs="$DOCKER_MOCK_DIR/containers/$container_name/rootfs"
    target="$rootfs$remote_path"

    if [[ "$src" == */. ]]; then
      # Copy directory contents: docker cp dir/. container:/dest
      srcdir="${src%/.}"
      mkdir -p "$target"
      cp -R "$srcdir/." "$target/"
    else
      # Copy single file
      mkdir -p "$(dirname "$target")"
      cp "$src" "$target"
    fi
    exit 0
  fi

  echo "Container-to-host cp not implemented in mock" >&2
  exit 1
  ;;

# ---------------------------------------------------------------------------
# docker inspect --format FORMAT CONTAINER
# ---------------------------------------------------------------------------
inspect)
  format=""
  container_ref=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --format) format="$2"; shift 2 ;;
      *) container_ref="$1"; shift ;;
    esac
  done

  container_name=$(resolve_container "$container_ref") || {
    echo "Error: No such object: $container_ref" >&2
    exit 1
  }

  cdir="$DOCKER_MOCK_DIR/containers/$container_name"
  status=$(cat "$cdir/status" 2>/dev/null || echo "stopped")
  exitcode=$(cat "$cdir/exitcode" 2>/dev/null || echo "1")
  full_id=$(cat "$cdir/id" 2>/dev/null || echo "unknown")

  # {{.State.Running}} {{.State.ExitCode}} — used by poll()
  if [[ "$format" == *"State.Running"*"State.ExitCode"* ]]; then
    if [ "$status" = "running" ]; then
      echo "true $exitcode"
    else
      echo "false $exitcode"
    fi
    exit 0
  fi

  # {{.Id}} {{.State.Running}} — used by lookupDockerContainer()
  if [[ "$format" == *".Id"*"State.Running"* ]]; then
    if [ "$status" = "running" ]; then
      echo "$full_id true"
    else
      echo "$full_id false"
    fi
    exit 0
  fi

  echo "{}"
  exit 0
  ;;

# ---------------------------------------------------------------------------
# docker rm [-f] CONTAINER
# ---------------------------------------------------------------------------
rm)
  container_ref=""
  while [ $# -gt 0 ]; do
    case "$1" in
      -f) shift ;;
      *) container_ref="$1"; shift ;;
    esac
  done

  # Silently succeed if container doesn't exist (matches real `docker rm -f`)
  container_name=$(resolve_container "$container_ref" 2>/dev/null) || exit 0

  cdir="$DOCKER_MOCK_DIR/containers/$container_name"
  if [ -d "$cdir" ]; then
    # Clean up ID mappings
    if [ -f "$cdir/id" ]; then
      full_id=$(cat "$cdir/id")
      short_id="${full_id:0:12}"
      rm -f "$DOCKER_MOCK_DIR/ids/$short_id" 2>/dev/null
      rm -f "$DOCKER_MOCK_DIR/ids/$full_id" 2>/dev/null
    fi
    # Remove the container entirely (matches real Docker behavior)
    rm -rf "$cdir"
  fi
  exit 0
  ;;

# ---------------------------------------------------------------------------
# Unknown command
# ---------------------------------------------------------------------------
*)
  echo "Unknown docker command: $cmd" >&2
  exit 1
  ;;

esac
