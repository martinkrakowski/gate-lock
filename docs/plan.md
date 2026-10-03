# `@hexagen-monaco/gate-lock`: implementation plan (rev 2)

This package is a host-wide gate lock. Every project and worktree on one host shares a pool of slots, and each slot carries a budget of test workers. It speaks **on-disk format 1**, as specified in `docs/requirements.md` (sections 1–8, numbered P/F/C/V/R/T/L/H). It is a clean-room implementation written from that specification.

Rev 2 applies an adversarial plan review: 2 blockers, 10 should-fix items and the nits.

## Goals and non-goals
- **Interop is the hard constraint.** Any other format-1 client on the same pool must see our slots as valid, and we must see theirs. Anything another client can *observe on disk* follows §2 of the specification exactly; §2 is frozen. Client-side behaviour that no other client observes may be stricter (D1–D22).
- **One source of truth.** Projects pin the package as a devDependency, so CI, laptops and shared hosts all run the same reviewed code with no host install.
- **Non-goals:**
  - pools shared by several uids (D17);
  - FIFO fairness;
  - Windows.

## Shape
- **`bin/gate-lock`** is POSIX `sh` (dash-clean and macOS `/bin/sh`-clean) with no runtime dependencies, and is the npm `bin` entry. Its preamble:
  - sets `LC_ALL=C`;
  - resolves `$0` to an absolute physical path once, so heartbeat re-invocation survives npm `.bin` symlinks and a command that `cd`s.
- **Subcommands:**
  - `acquire`, `heartbeat`, `verify`, `release`;
  - `status [--json]`;
  - `clean` (the janitor, D16);
  - `run [--status-file <p>] [--wait <seconds>] <lane> -- <cmd…>`;
  - `workers`;
  - `--format`, which prints `1`;
  - `--version`.
- **`src/index.js`** (ESM, with a `.d.ts`) exports `resolveMaxWorkers(env?)` (§4.8) and `FORMAT = 1`. It contains no lock logic.
- **Neutral names only:**
  - host variables: `GATE_LOCK_DIR`, `GATE_HOST_SLOTS`, `GATE_HOST_WORKERS`;
  - project overrides: `GATE_LOCK_SLOTS`, `GATE_LOCK_WORKERS`;
  - per-call variables: `GATE_LOCK_CALLER_PID`, `GATE_LOCK_SLOT_OUT`, `GATE_LOCK_SLOT_PATH`, `GATE_LOCK_STALE_SECONDS`, `GATE_LOCK_HEARTBEAT_SECONDS`;
  - test seams: `GATE_LOCK_TEST_*`, honoured only when `GATE_LOCK_TEST_MODE=1`;
  - message prefix: `gate-lock: `.
- **Exit codes:**
  - 0: ok;
  - 1: verify or release refused;
  - 2: refused (do not retry);
  - 75: busy (retry);
  - 129, 130, 131 and 143: HUP, INT, QUIT and TERM;
  - `run` otherwise passes the command's exit status through.
- **Not POSIX, but present on GNU, BSD/macOS and busybox,** and noted in the README: `date +%s`, `getconf _NPROCESSORS_ONLN`, `find -perm`. The tool never calls `stat` or `realpath`. It uses `cd … && pwd -P`, and the test harness uses Node's `realpathSync`.

## Decisions (D1–D22)
- **D1, pool resolution.** The pool is chosen in this order:
  1. `GATE_LOCK_DIR`, if set.
  2. `$XDG_RUNTIME_DIR/gate-lock`, if `XDG_RUNTIME_DIR` is *valid*: an absolute, plain, existing directory, owned by the uid, mode 0700, with no symlinked component.
  3. Otherwise the tool uses its own per-uid intermediate, `<physical TMPDIR or /tmp>/gate-lock-<uid>`, created with `mkdir -m 0700` and then verified (owned by the uid, 0700, not a symlink). The pool is `<intermediate>/pool`.

  F4–F8 apply to the pool's parent and leaf. With the intermediate in place, the parent is the tool-created 0700 directory, never the sticky `/tmp`; this is documented as the only exception to F7. If someone else pre-creates `/tmp/gate-lock-<uid>`, the result is exit 2 with a message naming `GATE_LOCK_DIR`. That is a DoS only.

  **Why dropping pool-less mode is safe for interop:** another client's pool-less mode keeps its slots under its *own* project-specific name in its temp directory (spec Q1), so it never shared slots with any other client in the first place. Interop happens only through a shared `GATE_LOCK_DIR`, which every shared host sets host-wide. The spec's pool-less clauses (F-pool-less, V-pool-less) are superseded by D1 for this package.

  There is no pool-less legacy mode. CI tests run with `XDG_RUNTIME_DIR` and `TMPDIR` both unset.
- **D2.** The marker's temp file is `.format.tmp.<pid>` and counts as a transient. `clean` removes it.
- **D3, liveness: exactly F41.** Any failure of the signal-zero probe means not alive, with no EPERM special case; this follows from D17 (one uid per pool).
- **D4: keep format semantics.** A future beat is never stale. `status` flags a beat more than 600 s in the future.
- **D5, numeric bounds.** Where §4 gives a rule for a numeric input (V3–V7, V11, V13: slot counts, worker counts and processor clamping), follow it **exactly**. For example, V7 accepts a `GATE_HOST_WORKERS` value of three or more digits without any arithmetic. The extra guard of digits only and at most 10 digits applies only to numeric inputs the spec does not bound: pid, beat, stale threshold and heartbeat interval.
  - A **beat** that is non-numeric or empty is treated as missing, as specified. A beat with more than 10 digits is treated as **future**, never stale.
  - A pid, threshold or interval that fails the guard is refused with exit 2, or treated as missing where the spec says so.
- **D6: no marker files.** `run` learns about a lost lock from the heartbeat loop's exit status: 0 when cleanup stopped it, 1 when a refresh failed. `run` reads that status with `wait` after the command ends.
- **D7.** An unpinned `release` by a caller that holds nothing exits 0 with "nothing to release". Releasing a slot pinned to another holder is refused with exit 1. T49 is amended to match.
- **D8: keep** the reclaim patience and pass counts.
- **D9: keep.** Configuration is resolved once, before the usage check.
- **D10, heartbeat supervision.**
  - `run` starts a supervisor subshell. The supervisor spawns the heartbeat loop as its own child, `wait`s on it, and restarts it once if it dies with a status other than 0 or 1.
  - On a second death, or a loop exit of 1 (a refresh failed), the supervisor sends TERM to the command, then KILL after a 10 s grace period, and exits 1.
  - `run` collects the supervisor's status in cleanup. A supervisor status of 1 makes `run` exit 2 with "lock lost".
  - The supervisor's own death remains the documented gap (Q10).
  - The tool never uses `kill -0` to decide that a child finished, because a zombie still answers the probe. Only `wait` decides that.
- **D11: keep rename semantics.** `mv` onto an existing directory nests on both GNU and BSD and never replaces, so the bounded patience of Q11 is preserved.
- **D12: release by rename-aside.**
  - `release`, the F60 give-back and reclaim all pick an aside name that does not yet exist (`[ ! -e ]`, then a numeric retry suffix).
  - After the rename they check for nesting (`[ -d "$aside/<slot basename>" ]`), as R2 does for candidates.
  - They then verify the three values. If verification fails, they rename the aside back when the slot name is free, so T22 ("release failed, the slot remains") holds.
  - The `<token>` in `.reclaim.<pid>.<token>` is **opaque** (F20 is amended): readers match `.reclaim.<pid>.*`.
- **D13: out of scope.** Worktree identity is the resolved toplevel or the physical path. The limitation is documented.
- **D14.** `acquire` validates the lane label under `LC_ALL=C` as printable ASCII, no newline, at most 128 bytes. Otherwise exit 2.
- **D15, signals in `run`.** HUP and QUIT are handled like TERM, and TERM is what gets *forwarded* to the command for HUP, QUIT and TERM, because asynchronous children ignore QUIT. `run` releases and exits 129, 131 or 143. INT is handled as specified, with exit 130.
- **D16, janitor: the `clean` subcommand, also run at the start of `acquire`, never on `status` (C27).**
  - It removes a transient (`.cand.*`, `.beatnew.*`, `.format.tmp.*`) only when its embedded pid is dead **and** it is older than the stale threshold. Age is checked with `touch -t <stamp> <ref>` plus `find <x> -prune ! -newer <ref>`.
  - It removes a `.reclaim.*` aside only when, additionally, F40 judges the aside's *contents* not alive: the recorded pid is dead, or the beat is stale.
  - Each removal prints `janitor: removed <name>` on stdout.
  - A pid-recycle race in which a new same-named `.cand` is removed is benign, because the creator's write fails (F31) and it retries. A code comment says so.
- **D17: one uid per pool.**
- **D18.** The shared code space is kept. `run --status-file <p>` writes one of `tool:<code>`, `cmd:<code>`, `busy:host` or `busy:worktree`. Options come before the lane, and `--` must follow the lane immediately (C29).
- **D19, a plan-level extension of §3 output (output text is not frozen; only §2 is).** `status` keeps every line §3 specifies: one line per existing slot, or the `free` line. It adds a final capacity line, `slots: <live>/<N> live, <stale> stale, pool <path>, format 1`, where live means alive and fresh. `status --json` is the only accepted argument (C-usage is amended) and gives a stable machine-readable form with schema version 1.
- **D20.** Test seams are honoured only when `GATE_LOCK_TEST_MODE=1`. Outside that mode, a set `GATE_LOCK_TEST_*` variable prints a warning and is ignored.
- **D21, output files** (`GATE_LOCK_SLOT_OUT`, `--status-file`). Each is checked **before the slot loop**, so a refusal takes nothing. It must be one of:
  1. an existing regular file, not a symlink, owned by the uid. This is what `mktemp` produces, in `/tmp` or macOS `/var/folders`. Write it in place, keeping the caller's inode.
  2. a path that does not exist and whose physically resolved parent (`cd && pwd -P`) is owned by the uid and not writable by group or others. Write a temp file beside it, then rename.

  Immediately before writing, check again that it is not a symlink.
- **D22, emptiness, aligned with the spec.**
  - An empty host variable (`GATE_HOST_*`) means unset.
  - An empty `GATE_LOCK_SLOTS` means unset, as V8 specifies.
  - A `GATE_LOCK_WORKERS` that is set but empty or unusable is refused with exit 2 and never falls through to the host value (V22, T99). The **lock tool adopts this same worker rule** as the resolver, which closes Q22.
- **D23, explicit modes.** The tool runs with `umask 077` and sets explicit modes on everything it creates: directories 0700, files 0600, `.format` included. Golden listings therefore do not depend on the developer's umask. Readers still accept other format-1 clients' slots and markers at any mode that F57–F59a and F11 allow, such as a 0664 `.format`.
- **Worker-cap honouring.** When the pool has N > 1 slots and neither `GATE_HOST_WORKERS` nor `GATE_LOCK_WORKERS` is set, `run` prints a warning; the exit code is unchanged. The README contract says the consuming test config must call `resolveMaxWorkers` and must not set a runner-level override beside it (V27).
- **Waiting.** `run --wait <seconds>` retries a busy result (75) with a jittered 1–5 s backoff until the deadline, then exits 75. The README documents it as the recommended caller loop.

## Lanes (sequential, test-first, one PR each)
- **GL0, scaffold and CI.**
  - `package.json`: name `@hexagen-monaco/gate-lock`, `bin`, `files` (`bin/`, `src/`, `.d.ts`, README), `engines.node >= 20`, `type: module`, and `repository.url` exactly `git+https://github.com/martinkrakowski/gate-lock.git`.
  - MIT LICENSE, README stub, ESLint, Prettier, vitest, shellcheck.
  - CI matrix: `ubuntu-latest` (dash as `/bin/sh`, plus a `bash --posix` leg) and `macos-latest`.
  - CI checks: `npm pack --dry-run` with an expected-file-list assertion; `bin/gate-lock` is mode 755 in git. The reference scan runs locally only, never as a committed term list.
  - `publish.yml` on `v*` tags:
    - `id-token: write`;
    - Node 22 with npm ≥ 11.5.1;
    - a check that the tag equals the `package.json` version;
    - `npm publish --provenance --access public`.
  - The test harness: a fresh pool per test (`mkdtemp` plus `realpathSync`), a controlled environment (§8.3), spec-exact slot-writing helpers, and a `find pool | sort` listing helper.
  - The spec and this plan go in `docs/`. The bin is only a stub that answers `--format` and `--version`.
- **GL1, configuration, pool and worker cap.** Variables §4 (V1–V28; D5, D22), pool resolution D1, directory rules F1–F20, the marker F21–F30 (D2), `resolveMaxWorkers` and `workers`. Tests: 6.H, 6.I, 6.J and 6.L.
- **GL2a, slots.**
  - candidate, rename and read-back;
  - busy;
  - reclaim F43–F51 with D12's aside rules;
  - forged-slot filters and pins;
  - `heartbeat`, `verify`, `release` (D7, D12) and `status` / `status --json` (D19).

  Tests: 6.A, 6.C, 6.E and 6.G, plus the reclaim parts of 6.B.
- **GL2b, races and hygiene.** Same-worktree and give-back (F60, D12), the janitor `clean` (D16), label validation (D14), and every pause-seam race test R1–R21 (§8.1). Tests: 6.B races and 6.F.
- **GL3, `run`.** Supervision (D10), lost lock (D6), signals (D15), `--status-file` and `--wait` (D18, D21), the worker-cap warning, and the full README (usage, the format-1 summary, exit codes, platform notes, the one-uid limit, the caller recipes, and the note that the `acquired` line precedes the slot-out write, so callers must check the exit code). Tests: 6.D and 6.K.
- **GL4, conformance.**
  - **Committed:** a black-box conformance suite that never uses the CLI to *write* fixtures. Spec-written helpers create 4-file and 6-file slots, `.format`, transients and planted forgeries byte for byte. The suite asserts the CLI's effects as golden directory listings and exact file bytes.
  - **Local cross-client run** against an existing format-1 client on one temporary pool, in both directions. Record the transcript in the release PR. Scenarios:
    - each side sees the other's slot as busy;
    - each side refuses to reclaim the other's live holder and reclaims the other's dead one;
    - the same worktree blocks across clients, with byte-equal identity;
    - `status` on each side lists the other's slot, `project` included;
    - a mixed N+2-client storm into N slots, 50 iterations, never more than N complete slots;
    - our janitor leaves the other client's fresh `.cand` and `.beatnew` files alone.

## Review and quality bar
- Every lane is test-first, with red-to-green evidence per item and a mutation check on every guard.
- Every T-item maps to at least one test, and test titles carry the T-ids.
- Each lane gets an independent pre-PR review and the bot reviews. CI must be green on both OSes.

## Release
1. **The owner does the first publish of 0.1.0 with 2FA:** `npm publish --access public` from a clean checkout of the tag.
   - It carries **no provenance**: provenance requires OIDC, so this gap is expected and is not a bug.
   - The owner then configures the trusted publisher (repo `gate-lock`, workflow `publish.yml`) and sets the package to trusted-publisher-only.
2. Later versions are published by tag through CI, with provenance.
3. After 0.1.0, consuming projects pin the package and run their lanes on a shared host through `gate-lock run`, with workers capped by `resolveMaxWorkers`.
