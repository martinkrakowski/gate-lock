# Host-wide gate lock: requirements specification (on-disk format 1)

Status: behavioural specification extracted from a working POSIX-sh implementation and its test suite, intended to drive an independent clean-room rewrite as a standalone, project-neutral package. It prescribes observable behaviour (files, exit codes, output, timing, races), not implementation. Where the original is shell-specific the requirement is stated in terms of the effect, so a rewrite in another language can meet it.

Conventions used below:

- "MUST" and "MUST NOT" mark requirements a conformance test should prove. Every numbered item is intended to be individually testable.
- A "slot" is one lock directory. A "pool" is the directory that holds all slots. A "holder" is the process whose pid is recorded in a slot. A "lane" is the free-text label a holder gives itself (the owner label). A "caller" is whatever launches the lock tool (a gate runner, a CI wrapper, a person).
- Message texts are not frozen except where this document names a required substring or a required exact line. Required substrings exist because tests and callers key on them.
- The CLI is called `gate-lock` in this document, and its diagnostic lines start with the prefix `gate-lock: `. Rename freely, but keep one prefix and use it everywhere.
- Env var names: the three host variables keep their contract names (`GATE_LOCK_DIR`, `GATE_HOST_SLOTS`, `GATE_HOST_WORKERS`). Every other knob uses the `GATE_LOCK_` prefix (table in section 4).

---

## 1. Purpose and model

**P1.** The tool serialises a bounded number of expensive jobs ("gates") on one host, across any number of projects and git worktrees, with one shared pool of N slots. At most N gates run at once on the host. A gate is any command a caller wraps with the lock.

**P2.** Each slot carries a budget of W test workers. N and W are one decision made once for the host, so that N × W does not exceed the host's processor count. The lock enforces the number of slots; a separate worker-cap resolver (section 4.8) gives test runners the W half. Oversubscription fails by running out of memory and by false timeouts on CPU-bound tests, so the tool validates the product rather than trusting it.

**P3.** The pool is host-wide. Two projects that name the same pool directory share one set of slots and spend the thread budget once between them. A project must not be able to hold more slots than the pool has, and must not run beside a holder it cannot see.

**P4.** Crash safety. A holder that dies, or stops answering, MUST NOT leave an orphan that someone has to delete by hand. Liveness (a live pid plus a fresh heartbeat) is the only release-by-force mechanism; the tool itself reclaims dead or silent slots. Humans are told never to remove a held slot by hand.

**P5.** One gate per worktree. Because the lock is per host and not per checkout, and a gate may mutate the tree it runs in, two live gates in the same worktree MUST NOT coexist even when free slots remain. Gates in different worktrees may run in parallel up to N.

**P6.** Everything is judged from what the slot records on disk: owner label, holder pid, start time, last beat, worktree, project name. There is no daemon and no lock server. The only primitives are atomic directory rename, hard-link-no-replace, and process-liveness probes.

**P7.** The tool is a developer-host mechanism, not a security boundary against hostile local users. It does harden against accidents and cheap forgeries (planted directories, symlinks, writable parents), and the threat model for those is in sections 2.9 and 6.

**P8.** Three tiers of host. (a) A pool host: `GATE_LOCK_DIR` set, so all rules below apply. (b) A pool-less host: variable unset or empty, so the slot set lives in the user's temp directory and the host variables are ignored. (c) A runner that never takes the lock (not covered here). Pool-less mode exists for CI runners and developer laptops with no shared host (see open question Q1).

---

## 2. On-disk format 1 (frozen)

Changing any item in this section bumps the format number. A rewrite targeting format 1 MUST interoperate with other format-1 implementations sharing one pool at the same time.

### 2.1 The pool directory

**F1.** The pool path MUST be absolute. A relative value is refused (exit 2), naming the value.

**F2.** Trailing slashes are reduced away before anything else is judged, so a trailing slash is never a different spelling of the same pool (the reduced path is what appears in every later message and slot path). The value that reduces to the filesystem root is refused (exit 2, message says the root is not a pool).

**F3.** The path MUST be plain. After reduction, any interior empty component (`//`), `.` component, `..` component, or a trailing `.` or `..` component is refused (exit 2, message says "plain absolute path"). Paths are refused, not normalised, because a spelling that can be walked is a way past ownership and symlink checks.

**F4.** The pool's parent directory is judged before anything is created. It MUST NOT be a symlink, MUST be a directory, MUST be owned by the expected uid, and MUST NOT be writable by group or others. Otherwise exit 2, the message names the parent path and the expected uid, and states that no lock was taken. A pool directly under the root is refused through this rule. A parent that is a shared sticky directory such as the system temp directory is refused even though the leaf would pass; the operator's fix is a parent under a per-user runtime directory or a home directory, not a mode on the pool.

**F5.** Every ancestor above the pool (the full chain from the pool's parent up to the root) MUST be a real directory, not a symlink. A symlink anywhere in the chain is refused (exit 2). The message names the link component and tells the operator to name the pool by its physically resolved path (print-working-directory with physical resolution). A symlinked parent is answered by the parent message (F4) first; a symlinked higher ancestor by this message. Ancestors above the parent are only checked for being non-symlink, not for owner or mode (a root-owned runtime-directory ancestor is fine).

**F6.** Order of directory checks: absolute, reduce, root, plain, parent judgement, ancestor walk, create, leaf judgement. Refusals in the first five steps MUST leave nothing created anywhere (not in the target of a link and not beside it).

**F7.** The pool leaf is created with owner-only access (mode 0700, set explicitly so the process umask cannot loosen it) if it does not exist. Creation failures, including "already exists", are ignored; the leaf judgement afterwards is what decides. The pool's parent must already exist; the tool does not create parents.

**F8.** After creation the leaf MUST NOT be a symlink, MUST be a directory, MUST be owned by the expected uid, and MUST NOT be group- or world-writable. Otherwise exit 2, naming the pool path, the expected uid and the three conditions, and stating no lock was taken. The refusal leaves the pool exactly as found: no marker, no slot, nothing published. Ownership and mode are read as file attributes, never inferred from "can I write to it" (the owner of a world-writable directory can write it, and that is the case that must be refused).

**F9.** The "expected uid" for the pool leaf is the current effective user's, unless the test seam in section 8 overrides it. The "expected uid" for the pool's parent is a separate seam that defaults to the leaf's value, so each of the two ownership claims can be made foreign independently by a test.

**F10.** An empty value for any of `GATE_LOCK_DIR`, `GATE_HOST_SLOTS`, `GATE_HOST_WORKERS` means unset, not an error. A wrapper that exports them unconditionally on a host with nothing to say must not be told it is misconfigured.

### 2.2 The `.format` marker

**F11.** The pool root holds one file named `.format`. Its content is the format number followed by a newline, which for this format is `1`.

**F12.** Publication: if the marker does not exist, write the content to a temporary file inside the pool (named after `.format` plus a per-process suffix), then hard-link the temp file onto `.format`, then remove the temp file. The hard link is the atomic no-replace: it fails if the name exists, and a rename or `mv -n` MUST NOT be used (neither is guaranteed no-replace and atomic on every platform, notably macOS). A link failure is not an error; it means another process published first.

**F13.** After publication (or if the marker already existed), the marker is READ BACK and compared. The comparison is on the content with trailing newlines trimmed, and the accepted value is exactly `1`. Anything else, including empty, truncated, `2`, unreadable or a directory, is refused (exit 2) with a message that names the pool variable, the value found (the word "nothing" when empty), and the number this gate speaks. A refusal takes no seat.

**F14.** An existing valid marker MUST NOT be rewritten, touched or replaced. A publisher that rewrote it would let two projects with different semantics overwrite each other's answer.

**F15.** Two acquirers racing into an absent pool both succeed: whichever link loses deletes its own temp file and reads back the winner's marker. The result is exactly one `.format` containing `1` and no leftover temp.

**F16.** A pool-less host (no pool variable) has no marker and no format check.

**F17.** The marker is checked after the directory checks and before the stale-threshold and slot-count checks, so a count refusal still leaves a correctly marked, empty pool behind.

### 2.3 Slot names, cap, and transients

**F18.** Slot 0 is named `gate.lock` inside the pool. Slot n (1 <= n <= 63) is named `gate.lock.<n>`. The cap on slots is MAX_SLOTS = 64, so slots are numbered 0 through 63.

**F19.** A directory is a slot name only if it is the base name, or the base name plus a dot plus a number written as one or two digits with no leading zero, that is below MAX_SLOTS. So `.0`, `.007`, `.64` and `.100` are not slot names, even when the configured slot count is 64.

**F20.** Transient names are derived from a slot's own path and are never slots. (Rev 2: the `<token>`/`<pass>` part of a reclaim aside is opaque; readers match `.reclaim.<pid>.*` and must not assume digits.)

- `<slot>.cand.<pid>`: the candidate directory a creator fills before renaming it onto the slot name;
- `<slot>.reclaim.<pid>.<pass>`: where a reclaimer moves a slot aside;
- `<slot>.beatnew.<pid>`: a staged beat file next to the slot (a file, not a directory) before it is renamed onto the slot's beat.

All three are siblings of the slot (same directory, hence same filesystem). The pid is the creating process's own pid. The pass is the reclaimer's pass counter for that slot.

**F21.** Because the slot-name shape in F19 is strict, a transient whose name begins with a digit after the base (for example a candidate for slot 1) is not read as a slot by any scan. The shape rule is what keeps transients out of the slot set, not where they sit. A glob "base dot digit anything" is incorrect.

**F22.** Transient and slot names are the same in every project that draws from the pool, because the pool is shared. They do not contain any project name.

**F23.** The temporary file used to publish the marker (F12) is a fourth transient living in the pool root. It is not in the original frozen list (open question Q2).

### 2.4 The six files in a held slot

A slot is a directory holding exactly these files, each one line ending in a newline. They are written inside the candidate directory before the rename, so a slot that exists is complete.

**F24.** `owner`: the lane label of the holder, free text.

**F25.** `pid`: the holder's pid. This is the process that stays alive for exactly as long as the protected work (see section 3, caller pid).

**F26.** `started`: epoch seconds at acquisition.

**F27.** `beat`: epoch seconds of the last heartbeat. Initially equal to `started`.

**F28.** `worktree`: the caller's worktree identity at acquisition: the git top-level directory of the caller's working directory if it is inside a repository, otherwise the physically resolved working directory. Empty is not an identity (F55).

**F29.** `project`: the last path component of the worktree string. Display only: `status` prints it so a slot held by another project reads as one. Nothing validates or compares it. A slot without the file prints `unknown` and is never treated as a forgery.

**F30.** Compatibility: a slot with only the first four files (written before worktree and project existed) is a valid slot. A slot with no `worktree` file, or an empty one, never blocks anyone under the same-worktree rule (section 3.2 acquire).

**F31.** Writing any of the files in the candidate fails the creation attempt, removes the candidate and counts as not winning the name.

**F32.** After the rename, the creator reads the `pid` file at the final name and compares it to its recorded pid. A mismatch means it did not win. A rename can never replace a non-empty directory, so a match proves the creator's own content is at the name.

**F33.** A busy attempt MUST leave a holder's slot byte-for-byte untouched. Specifically, the contents of the holder's directory (names only) stay as they were after any number of failed attempts. See R2 for the nesting hazard.

### 2.5 Heartbeat cadence and stale threshold

**F34.** Every holder beats at least every 60 seconds. The default heartbeat period of the wrapper is 60 seconds.

**F35.** The stale threshold defaults to 600 seconds. A beat is stale when the current time minus the beat is greater than or equal to the threshold. The threshold is read by every reader (acquire, status, same-worktree scan, self-held scan), so it MUST be the same for every participant in a pool.

**F36.** Under a pool, a threshold below 600 is refused (exit 2). Format 1 treats 600 as a floor, not a default: one seat lowering it would reclaim live holders belonging to other projects. Without a pool the threshold may be any non-negative whole number. The threshold value must be digits only; anything else is refused (exit 2) naming the variable.

**F37.** A beat that is empty, missing or not all digits counts as stale. A beat in the future (a clock stepped between holders) is not stale.

**F38.** The beat is refreshed by writing the new value to a staged file beside the slot and renaming it over the beat file, never by truncating and rewriting. A reader must see the previous beat or the next beat and never an empty or missing one (R6).

**F39.** The staged beat file MUST live in the pool (a sibling of its slot) and never on the temp directory, because a rename across filesystems is copy-then-delete, and the beat would be briefly absent at the name, which a reader judges as stale.

### 2.6 The liveness rule

**F40.** A slot's holder is "answering" iff its recorded pid is alive AND its beat is fresh (not stale per F35/F37). Both conditions are required.

**F41.** Pid liveness is a signal-zero probe on the recorded pid. An empty pid, the pid zero (which would signal a whole process group), and anything that is not all digits count as not alive.

**F42.** A pid can be recycled after a crash. That is why the beat exists: a live-looking pid with a stale beat is reclaimed. And a dead pid with a fresh beat is reclaimed.

### 2.7 Reclaim, step by step

Inputs: the acquirer is working slot S, on pass p (1-based, per slot), and has just failed to create S because the name exists.

**F43.** Create attempt first. Every pass begins with an attempt to create S (candidate fill, rename, read-back). Success ends the loop for S. A failure is not an error: it means the name is held.

**F44.** Inspect. Read S's `pid`, `beat` and `owner` (empty on any read failure).

**F45.** Bounded patience for a partial or abandoned slot: if both pid and beat are empty, or the pid is alive and the beat is empty, and p < 3, sleep one whole second and start the next pass (re-read). Creation is atomic, so this can only be an abandoned or corrupted slot; patience is bounded and then the reclaim happens at pass 3.

**F46.** Busy. If the pid is alive and the beat is fresh, S is held by an answering holder. Remember the first such holder seen (owner, pid, beat, slot path) for the final message, then move on to the next slot.

**F47.** Contention exit for a slot. If p >= 5 (five passes without winning the name), someone else is reclaiming it. Treat S as unavailable (remember the holder if none remembered yet, use `none` for a missing pid or beat) and move on to the next slot.

**F48.** Announce. Otherwise S is reclaimable. Print to stdout, before moving anything, one of two lines: one saying the holder is not alive (naming the owner, pid and slot path), or one saying the heartbeat is stale or missing (naming the owner, pid, beat or the word missing, threshold in seconds, and slot path). The required substrings are `reclaiming` and then `not alive` or `stale` respectively.

**F49.** Rename aside. Rename S to `S.reclaim.<own pid>.<p>`. The pass number keeps an aside left by an earlier pass from blocking this pass's rename. If the rename fails (another reclaimer won, or a fresh holder re-created the name), start the next pass.

**F50.** Verify what moved. Read owner, pid and beat from the directory now at the aside name. If all three equal the values judged stale in F44, delete the aside, and begin the next pass (which will try the create again).

**F51.** Mismatch means the rename moved a different slot from the one that was judged (a fresh holder replaced the stale one between inspect and rename). That slot was never judged, so it is NEVER deleted. If the original name is free, rename the aside back and print a line to stderr stating the reclaim was aborted and the slot restored. If the name has been taken in the meantime, leave the aside in place and print a line to stderr stating the reclaim was aborted, the moved copy was left at its path, and that it is never deleted. Either way the pass continues (so the acquirer re-inspects whoever holds the name now).

**F52.** The reclaimer's `reclaim.<pid>.<pass>` leftover from the mismatch path is not cleaned by this tool (open question Q16).

### 2.8 Slot order, busy, same-worktree, and exit

**F53.** Slots are tried in order, slot 0 up to the configured count minus one. The first free or reclaimable slot is taken. Only a caller that has run out of slots is busy.

**F54.** If every slot is busy, exit 75 and print to stderr one line containing the word `busy`, the first remembered holder's owner, pid and beat, and its slot path, plus the advice to sleep and retry and never to remove the lock by hand. The first holder found is named, not the last, because it is likelier to free up first.

**F55.** Identity required. The caller's worktree identity is resolved once per acquire before any slot is touched. If it comes out empty (the working directory was deleted or is unreadable), exit 2, take nothing and leave no candidate behind. Message contains the phrase "cannot determine the caller's worktree". An empty identity would silently disarm the one-gate-per-worktree rule.

**F56.** One gate per worktree. After winning a slot (after the read-back in F32) and before printing anything or writing the slot-path output, scan every OTHER slot that passes the canonical-name and provenance filters (F57), including slots beyond the configured count. If any has a non-empty `worktree` file equal to the caller's AND an answering holder (F40), then: give back the slot just won (conditionally, F60), print the busy line (stderr) naming "same worktree", the worktree, the holder's owner, pid and beat, and the holder's slot path, and exit 75. The scan is over ANY other slot, not only lower-numbered ones: yielding only downward lets a third holder's release re-order two acquirers so that two gates run in one worktree.

**F56a.** Dead or stale same-worktree holders do not block. The scan applies the same liveness judgement as the slot loop and nothing stricter, and it never reclaims or alters the slot it reads.

**F56b.** A same-worktree refusal does not write the slot-output file and does not print the `acquired` line.

**F56c.** Known residual: if two same-worktree acquirers both win slots before either scans, both yield and both exit 75 (neither runs). This is accepted as the ordinary busy contract. Neither can both run.

### 2.9 Forged-slot identification

A slot directory in a possibly shared parent can be planted by someone else. A directory is accepted as a real slot ONLY if all of the following hold (the "canonical and provenance filters"):

**F57.** Canonical name per F19, relative to the active base.

**F58.** Not a symlink. This check is made on its own and first, because a file-attribute query on a symlink reports the link's own owner and never looks through it, so a symlink into a tree the user owns would otherwise pass the ownership test. Trailing-slash spellings MUST NOT be used to resolve a path before judging it.

**F59.** A directory.

**F59a.** Owned by the expected uid. The uid override seam (section 8) is inert when empty. A directory is judged without descending into it.

**F60.** A slot given back by an acquirer (same-worktree refusal, or failure to record the slot-path output) is removed only if the owner and pid in it are still this invocation's. If the name has since been taken by another holder, it is left completely alone.

**F61.** Planted directory attack catalogue the filters must defeat: a non-canonical name carrying a real holder's owner and pid; a symlink at a canonical name; a canonical directory owned by a different uid; a canonical name above or below the configured count; a pin (F66) at any of these. Each must be invisible to `status`, to unpinned callers, and rejected by pinned callers.

### 2.10 Pinning

**F62.** A holder is told which slot it took (via the slot-path output file) and every later action (beat, verify, release) is handed that single path and never scans. The reason is that a scan answers whoever planted a directory that sorts first, so a forged slot carrying a real holder's owner and pid could be refreshed while the real slot goes stale and is reclaimed.

**F63.** Callers with no pin (anything that did not come from an acquire) still scan, but only over slots passing F57 to F59a, and match on owner and pid (release, verify) or on pid alone (heartbeat, because it takes no lane).

**F64.** A pin is a claim from the environment, not a fact. It MUST be a canonical slot name for the active base (else exit 2, message names the pin path and states it is not a slot on this host). If it exists it MUST pass F58 to F59a (else exit 2, message names the pin path and says it was left alone). A pin that does not exist is not a forgery; it is a lock the caller has lost, and the subcommand's own "no lock" answer applies (exit 1).

**F65.** Exit 2 for a bad pin is deliberately not exit 1: a broken invocation must not be answered as a lost lock, which would send a live holder's gate down its lock-lost path.

**F66.** `run` clears any inherited pin before its own acquire, sets its own pin afterwards, and does NOT export that pin to the command it wraps. The wrapped command and everything it spawns see no pin.

**F67.** One pid, one slot. An acquire whose caller pid already holds an answering slot (live pid, fresh beat, any scanned slot, including beyond the configured count) is refused with exit 2 (not 75) before any slot is touched: the message contains "already holds" and the slot path. A holder taking a second slot would leave the first with nothing refreshing it. A same-pid slot with a stale beat is not refused: it is a recycled pid and is reclaimed by the normal path.

### 2.11 What reclaimed slots need from the filesystem

**F68.** Pool and slots MUST be on a single local filesystem with real atomic rename and hard links. A pool on a union or network filesystem (merging unions, NFS) is unsupported and may merge branches such that two candidates both win one name, or a cross-branch rename degrades to copy-then-delete, which is the race that reclaims a live holder.

**F69.** Pid namespace: every participant (every acquirer, holder, reader) MUST share one pid namespace. A containerised participant reads every pid as dead and reclaims live holders. See section 7.

---

## 3. The CLI interface

Program name `gate-lock`. Synopsis:

- `gate-lock run <lane> -- <command ...>`
- `gate-lock acquire <lane>`
- `gate-lock release <lane>`
- `gate-lock verify <lane>`
- `gate-lock status`
- `gate-lock heartbeat`

### 3.1 Global behaviour

**C1.** Process-wide configuration (pool path and its checks, format marker, stale threshold, slot count, host-variable cross-checks) is resolved once per invocation, for EVERY subcommand, before the subcommand runs. A configuration refusal is exit 2 whichever subcommand arrived, is reported as itself, and takes precedence over subcommand-specific refusals (for example, a bad stale threshold on a bare acquire is reported as the bad threshold, not as the missing caller pid). It also takes precedence over the usage error (open question Q9).

**C2.** Usage errors exit 2 with a line starting `usage` on stderr, and take no lock. Cases: unknown subcommand; no subcommand; `run` missing the lane; `acquire`, `release` or `verify` missing the lane; `status` or `heartbeat` with extra arguments.

**C3.** Stream convention: informational and success lines go to stdout (acquired, reclaiming, released, nothing to release, the heartbeat-pid line, status lines). Refusals and failures go to stderr. The busy line is on stderr, and it is how a busy lock is told apart from a wrapped command that itself exited with the same number.

**C4.** The paths in messages are the slot's full path including the pool directory, spelled exactly as the slot path is spelled everywhere else, so a reader can go and look at it.

**C5.** Environment inputs (see section 4 for the full table):

- `GATE_LOCK_CALLER_PID`: the pid to record and to match on.
- `GATE_LOCK_SLOT_OUT`: path of a file to receive the slot path after a successful acquire.
- `GATE_LOCK_SLOT_PATH`: the pin for release, verify and heartbeat.
- `GATE_LOCK_HEARTBEAT_SECONDS`: the period for `run`.
- `GATE_LOCK_STALE_SECONDS`: the threshold.

### 3.2 Subcommands

**acquire**

**C6.** `acquire <lane>` takes one slot for lane `<lane>` and exits 0 on success. It REQUIRES a caller pid (`GATE_LOCK_CALLER_PID` non-empty). A bare acquire with no caller pid is refused (exit 2), naming the variable and recommending the `run` wrapper, and it is refused whether the lock is free or held. Reason: the only pid it could record is its own, which dies before the caller runs a single step, so the lock would be reclaimable the instant it was taken. "Busy" is not an answer to a call that can never work. Nothing is written, nothing reclaimed.

**C7.** The caller pid is whatever long-lived process the caller wants to be answerable for the lock: a gate runner passes its own pid. It is never guessed. An already-dead caller pid is accepted at acquire time (the slot will be reclaimed by the next contender), which is how tests seed holders.

**C8.** Order of acquire checks, after configuration: caller-pid refusal, self-held refusal (F67), worktree identity (F55), slot loop (section 2.7/2.8).

**C9.** Success: exit 0, stdout line containing `acquired by <lane>`, the caller pid and `at <slot path>`. Then, if `GATE_LOCK_SLOT_OUT` is non-empty, the slot path plus a newline is written to that file. If writing fails, the slot is given back (conditionally, F60), exit 2, stderr says the slot cannot be recorded and the lock was given back. A caller that cannot be told which slot it holds must not be left holding one nobody can pin.

**C10.** Reclaim lines (F48) appear on stdout, before the `acquired` line, for every slot reclaimed on the way.

**C11.** Exit 75, busy, per F54 and F56. Exit 2 per C6, F55, F64, C1.

**C12.** The `GATE_LOCK_SLOT_OUT` file is written only on success of the whole acquire, only after the same-worktree check, and never when refused.

**release**

**C13.** `release <lane>` removes the caller's own slot, only while the slot still names this lane AND this caller pid. With a pin, only the pinned slot is considered (and F64 applies). Without a pin, the caller's slot is found by scanning the filtered set for owner AND pid; if no slot matches, the judgement falls back to slot 0's path.

**C14.** If the slot does not exist: stdout line containing `nothing to release` and the path, exit 0 (idempotent).

**C15.** If it exists but the owner or pid does not match: exit 1, stderr contains `release refused` and names the owner/pid found and the lane/pid expected. The slot is left alone. This covers both a wrong pid with the right owner (a reclaimed holder trying to delete its replacement) and a wrong owner with the right pid.

**C16.** If removal fails (for example, a read-only slot directory): exit 1, stderr contains `release failed`, the slot remains. It MUST NOT be announced as released.

**C17.** Success: exit 0, stdout line containing `released by <lane>` and the slot path.

**verify**

**C18.** `verify <lane>` exits 0 and prints nothing while the slot still names this lane and caller pid. It is the "am I still the holder" probe a runner calls at step boundaries.

**C19.** Slot missing: exit 1, stderr contains `verify` and `no lock` and the path. Owner or pid mismatch: exit 1, stderr contains `verify failed` and names who it found. A stranger's pid can never verify through someone else's slot, whichever slot that is.

**C20.** Pin handling as for release (F64 exit 2).

**heartbeat**

**C21.** `heartbeat` takes no lane. It refreshes the beat of the pinned slot, or, without a pin, of the first filtered slot whose pid equals the caller pid. It writes only when the slot still names the caller's pid.

**C22.** Slot missing: exit 1, stderr contains `no lock` and says there is nothing to refresh. Pid mismatch: exit 1, stderr contains `heartbeat refused`, and the beat file is unchanged.

**C23.** Success: exit 0, silent. The beat becomes the current epoch second, replaced atomically (F38/F39). If the staged write or the rename fails: exit 1, stderr contains `heartbeat` and says it cannot write or cannot replace the beat, and the staged file is removed. A rename failure after a reclaim removed the slot is how a holder learns the lock is gone.

**C24.** With multiple scan matches or multiple pinned-capable slots, an unpinned heartbeat takes the first match (the invariant "one pid holds one slot" is enforced by acquire, not by this scan). A pinned heartbeat refreshes only the pinned slot, leaving decoys that carry the same owner and pid untouched.

**status**

**C25.** `status` prints one line per existing slot (every slot passing the filters, regardless of the configured count, so a host whose slot count was lowered under a holder still shows that holder) and exits 0. Each line contains: the slot path, `held by`, the owner (or `unknown`), `project`, the project (or `unknown`), the start time (or `?`), a liveness phrase (`pid <n> alive` or `pid <n|none> not alive`), and a heartbeat phrase (fresh with the beat value, or stale or missing with the threshold). The substring `<slot path> held by <owner> project <project>` is contiguous.

**C26.** No slots: one line starting `free` and naming the base slot path, exit 0.

**C27.** `status` is read-only. It never lists a transient and never touches one. It lists slots whose holders are dead or stale (with the phrase saying so); it does not reclaim.

**run**

**C28.** `run <lane> -- <command ...>` holds a slot around one command. The holder pid recorded is `run` itself, whatever caller pid was inherited from the environment (an inherited pid belongs to whatever launched the tool and is free to exit mid-command).

**C29.** Syntax: the separator `--` MUST immediately follow the lane. A stray word where the separator belongs (`run lane extra -- cmd`), a missing separator, an empty command, and a missing lane are all usage errors (exit 2) that take no lock. A `--` after the first one is an ordinary argument to the command. The command is run exactly as given, as an argument vector, with no re-parsing, so arguments containing spaces arrive intact.

**C30.** Heartbeat period validation happens BEFORE the acquire: non-numeric is refused (exit 2) naming the variable; zero is refused (exit 2) with "at least one second" (a zero interval spins a process-forking loop instead of sleeping). Neither leaves a lock.

**C31.** Sequence: install signal handling and cleanup, then acquire (including reclaim and busy rules, on stdout/stderr as for the `acquire` subcommand), then start the command in the background, then start the heartbeat loop, then print a stdout line containing `heartbeat pid <n>` (the heartbeat loop's pid) and `every <s>s while <lane> runs`, then wait for the command.

**C32.** The command inherits the tool's stdout and stderr unchanged: no capture, no buffering, so a failing test run is reported live and the exit code is not the only thing that arrives. Its stdin is null. (The wrapped commands do not read input.)

**C33.** Busy at acquire: exit 75, the command is never started, no lock is left, the stderr busy line is present. A nested run (a run inside a run, same host, same worktree) loses rather than deadlocks or steals; its command never starts and the outer run still cleans up.

**C34.** Exit status of `run`: the command's own exit status (including 3, 127 and so on) when the lock was held to the end and released; 130 when interrupted; 143 when terminated; 75 busy; 2 usage, configuration or refusal; non-zero (1 if the command succeeded) when the lock was lost or could not be released.

**C35.** After the command ends, `run` verifies the lock is still its own. If not (the slot was deleted or replaced while the command ran), it prints the verify failure and exits non-zero even though the command succeeded; if the command had failed it keeps the command's status. Releasing a lock that is simply gone is not an error by itself (idempotent release), which is why the verify is separate. Replacing the lock with someone else's must leave the replacement intact.

**C36.** On any exit path (success, failure, signal, refused acquire) `run` releases the slot, but only the slot that is still its own (F60/C13). If release fails or is refused it prints a stderr line containing `FAILED to release the lock` with the slot path, and the exit is non-zero (1 when it would have been 0).

**C37.** Heartbeat loop. A background loop refreshes the beat once per period by invoking the heartbeat subcommand with the caller pid set to `run`'s pid and the pin set to the slot `run` took. The loop's stdio is detached. If a refresh fails (lock gone, or someone else's), the loop writes a failure marker, sends TERM to the command and exits non-zero. After the command ends `run` sees the marker and prints a stderr line containing `the lock was lost while the command ran` and says the command was stopped. A lost-lock run exits non-zero and does not delete the replacement.

**C38.** Signals to `run` (section 5, R8): INT leads to exit 130, TERM to exit 143. Both forward TERM (not INT) to the command, wait for the command to end (no timeout), and then clean up. The lock is released only after the command has actually stopped; the slot name is not handed on while the command is still writing. The heartbeat loop is stopped and reaped; nothing outlives `run`. Both exit codes are chosen so a caller can tell a signalled run from a failed command.

**C39.** Why TERM is forwarded for INT: a background command in a non-interactive POSIX shell starts with INT and QUIT ignored, so a forwarded INT is a no-op for a plain shell command, leaving it running after the lock is gone. TERM is not in that class and reaches every command. Job control MUST NOT be used as an alternative: it moves the command out of the terminal's foreground process group, so the interrupt key stops reaching it.

**C40.** A second INT or TERM arriving after the first is IGNORED, in both the forwarding phase and the cleanup phase. Re-handling it is the one thing worse than ignoring it, because it can skip the cleanup that releases the lock. The consequence is that nothing outside can break the wait except SIGKILL, on the command (clean unwind) or on `run` (leaves a slot the next acquire reclaims as dead pid).

**C41.** Cleanup MUST wait for any in-flight heartbeat refresh before removing the slot (R7): the loop only exits when no refresh of its own is still running, and `run` waits for the loop before releasing. This prevents a refresh renaming a file into a directory that is being removed (a false "directory not empty" release failure, a left-over lock and a non-zero exit for a successful command).

**C42.** The heartbeat loop's pause between refreshes is interruptible: a TERM to the loop takes effect at once (not after up to a period) and leaves no orphaned sleeper.

**C43.** If the signal arrives between acquire (slot exists on disk, named for this run) and the point where `run` records that it holds the lock, the cleanup still releases it (R9). The cleanup releases whenever the run may have taken a lock (held flag set, or a slot naming this lane and this pid exists), but NOT after a busy refusal (the slot names someone else; it belongs to a run still working) and not before any lock exists.

**C44.** A command that exits with 75 on its own is not a busy lock. Only the stderr busy line from the tool's own refusal distinguishes the two.

**C45.** Gap, documented as intentional: nothing watches the heartbeat loop's own death. If someone kills the loop's pid, the beat goes stale, the next acquire reclaims the slot, and the command continues unprotected until it ends. `run` closes the other direction (a refresh that fails stops the command) but not this one (open question Q10).

### 3.3 Exit code table

| Code  | Meaning                                                                                                                                                                               |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | success (acquire, release including nothing-to-release, verify ok, heartbeat ok, status always, run with command exit 0 and clean release)                                            |
| 1     | verify failed or no lock; heartbeat refused or no lock or cannot write/replace; release refused or failed; run where the lock was lost or release failed and the command had exited 0 |
| 2     | usage error; any configuration refusal; bare acquire; acquire while self-held; empty worktree; slot output unwritable (slot given back); bad pin; bad heartbeat period                |
| 75    | busy: every slot answering; or same worktree. Also what `run` exits when its acquire is busy.                                                                                         |
| 130   | `run` interrupted by INT                                                                                                                                                              |
| 143   | `run` terminated by TERM (also what the command's own TERM status becomes when the heartbeat loop stops it, in practice)                                                              |
| other | `run` returns the wrapped command's own status                                                                                                                                        |

### 3.4 How a gate runner uses it (informative, derived from the observed caller)

These are requirements on the package's contract so that a runner can be written against it. The runner itself is out of scope but its use pins down the interface.

**C46.** Runner acquire: the runner calls `acquire` with the caller pid set to the runner's own pid and the slot-output path set to a freshly created private temp file (made by a secure temp-file call; never a predictable name, because the lock parent and TMPDIR may be shared), and propagates a non-zero acquire exit as its own exit (so 75 reaches its caller, which sleeps and retries).

**C47.** The runner reads the slot path back from that file and uses it as the pin for the rest of its life. It treats an acquire that succeeded but left no slot path as a failure (and still releases whatever the cleanup can name).

**C48.** The runner runs its own heartbeat loop (when it does not use `run`): a background loop invoking the heartbeat subcommand every period with caller pid = runner pid and the pin; on failure it writes a failure marker file and exits. The foreground checks, before and after each locked step, that the loop is still alive, that the marker is absent and that `verify` still passes. Any failure is "lock lost": the protected steps stop.

**C49.** The runner releases on every exit path through one cleanup, pinned, with the caller pid set to its own pid. It ignores further INT/TERM until the release has run, sends the release's stdio to the caller's original stdout and stderr (not to a step's redirected files), starts at most one release, and if the acquire child was signalled mid-acquire (the lock won, the pin not yet read) it reads the slot-output file and releases what that names. A failed release prints a failure line and makes the gate non-green.

**C50.** The runner's step boundary check calls `verify` quietly and treats exit 1 and exit 2 alike as lock lost.

---

## 4. Host variables and validation

### 4.1 Variable table

| Variable                      | Scope      | Meaning                                                                                                   |
| ----------------------------- | ---------- | --------------------------------------------------------------------------------------------------------- |
| `GATE_LOCK_DIR`               | host       | Pool directory. Unset or empty means pool-less mode.                                                      |
| `GATE_HOST_SLOTS`             | host       | Number of slots in the pool. Optional.                                                                    |
| `GATE_HOST_WORKERS`           | host       | Workers one test run may spawn. Optional.                                                                 |
| `GATE_LOCK_SLOTS`             | project    | A project's own view of the slot count (pool-less: the count; pool: must agree with the host). Default 1. |
| `GATE_LOCK_WORKERS`           | project    | A project's own worker cap. Read by the worker-cap resolver; compared to the host's under a pool.         |
| `GATE_LOCK_STALE_SECONDS`     | per call   | Stale threshold seconds. Default 600; under a pool at least 600.                                          |
| `GATE_LOCK_HEARTBEAT_SECONDS` | per call   | `run` heartbeat period. Default 60, at least 1.                                                           |
| `GATE_LOCK_CALLER_PID`        | per call   | Pid to record and match.                                                                                  |
| `GATE_LOCK_SLOT_OUT`          | per call   | File to receive the acquired slot path.                                                                   |
| `GATE_LOCK_SLOT_PATH`         | per call   | Pin.                                                                                                      |
| `GATE_LOCK_TEST_*`            | tests only | Section 8.                                                                                                |

**V1.** Host variables are set host-wide (for example in a system environment file for all sessions) and never in one seat's environment. The number of slots is a property of the host, and a seat's own view of it is the thing that is wrong. A seat that caps its own workers below the host's gets a lane whose timeout budget nobody else runs under.

**V2.** Pool-less mode: the slot set lives at `<temp directory>/gate.lock` (temp directory is `TMPDIR`, falling back to `/tmp`), with numbered siblings and the same transients. The host variables are not consulted at all, an operator exporting old and new settings during a migration gets no refusal for the ones not yet migrated, and no marker is created. The slot count comes from `GATE_LOCK_SLOTS` (default 1). A stale threshold below 600 is allowed. (Name and legacy question: Q1.)

### 4.2 Slot-count parsing

**V3.** A slot count (from any variable) must be all digits. Else exit 2 with message naming the variable and "must be a number of slots" and the value as given.

**V4.** Leading zeros are a spelling and are stripped before judging, keeping at least one digit: `064` is 64, `006` is 6, `00` and `0` are zero. A value of three or more digits after stripping is over the ceiling by its digits alone, with no arithmetic comparison attempted (a 20-digit or 30-digit value cannot be compared by a shell and would otherwise fall through every range test and report an idle host as busy forever).

**V5.** Over 64 slots: exit 2, and the stderr line is exactly: the prefix, the variable name, the words `must be at most 64 slots`, a colon, a space, then the value AS GIVEN (so `065` appears as `065`), and a newline. No busy line and no arithmetic diagnostic. Zero (as `0`, `00` or any spelling) is exit 2 with exactly: prefix, variable name, `must be at least one slot`, colon, space, value as given. Exactly 64 and `064` are accepted.

**V6.** Count validation happens before any slot is touched; a refused count leaves no lock behind. "At least one" exists because zero is not a host with no gates, it is a host where every caller is silently unprotected.

### 4.3 Worker-count parsing (the host variable)

**V7.** `GATE_HOST_WORKERS`, when non-empty, must be all digits, leading zeros stripped, at least 1; else exit 2 naming the variable ("must be a number of workers" or "at least one worker"). A value of three or more digits is accepted as at least one with no arithmetic comparison. It is NOT bounded by 64 and NOT compared to the processor count by the lock tool (the lock sees the host's thread count and a container's cpuset may differ; refusing would stop the gate on the hosts that need it most). That comparison belongs to the worker-cap resolver, which runs where the workers are spent (4.8).

### 4.4 Slot count in a pool (precedence)

Applies only when `GATE_LOCK_DIR` is set. Steps run in this order, after the pool and marker checks and the stale-threshold checks.

**V8.** If `GATE_LOCK_SLOTS` is non-empty, parse it as a count first and on its own (so a non-count is refused as such, whatever the host says), and keep it as the project's view.

**V9.** If `GATE_HOST_WORKERS` is non-empty, parse it (V7). If `GATE_LOCK_WORKERS` is also non-empty, compare them AS NUMBERS after stripping leading zeros on both sides (so `04` and `4` agree and are not a disagreement) and refuse (exit 2) a difference. The refusal names both variables with the project value as given and the host value, and says a run's cap and the host's budget are one decision.

**V10.** If `GATE_HOST_SLOTS` is non-empty, it is the pool's count (parsed with V3-V6, naming `GATE_HOST_SLOTS`).

**V11.** Else if `GATE_HOST_WORKERS` is non-empty, derive the count: processors divided by workers (integer division), with a minimum of 1 and a maximum of 64. 24 and 4 give 6; 24 and 5 give 4; 3 and 4 give 1 (a host with fewer threads than one worker's worth still gets one gate). The processor count is read from the system's online-processor count (the portable source), after stripping leading zeros; any value of nine or more digits is clamped to a safe ceiling before dividing (arithmetic that wraps would give a wrong slot count). A processor count that is not all digits is refused (exit 2) with a message naming `GATE_HOST_WORKERS`, the system query, and the word "derive", and advising to set `GATE_HOST_SLOTS` or unset the workers variable.

**V12.** Else (neither host variable): the project's own count (default 1).

**V13.** Budget check. If the count came from `GATE_HOST_SLOTS` AND `GATE_HOST_WORKERS` is non-empty: refuse (exit 2) when slots exceeds floor(processors / workers). Equivalent to slots times workers exceeding processors, but computed as a division of clamped values so a huge digit string cannot overflow the arithmetic. The message names `GATE_HOST_SLOTS=<n>`, `GATE_HOST_WORKERS=<n>` and the number of processors followed by the word "processors" and tells the operator to lower the slots, raise the workers, or unset the workers and let the count be derived. 24 processors accept 6 and 4, refuse 7 and 4, refuse 6 and 5. If the processor count is not a number this check refuses (exit 2) with a distinct message: it names the two variables with `GATE_HOST_SLOTS=<n> with GATE_HOST_WORKERS=<n>`, mentions the system query, and says the numbers "can only be checked against" the host's processor count. This message is different from the derivation one because the operator fixes it differently.

**V14.** `GATE_HOST_SLOTS` on its own (no workers) is allowed and leaves the worker cap uncapped. That host has decided its own default is the cap; there is no second number to check it against.

**V15.** Disagreement. If the project count (V8) was given AND the pool has a host-sourced count (V10 or V11) AND they differ numerically, refuse (exit 2) naming the project variable and value, the host variable that gave the count and its value, and the pool path. Rationale: a seat that believes the host has fewer gates than it does takes one beside a holder it cannot see. Lock correctness survives the disagreement; the thread budget does not.

**V16.** Check order in a pool: pool path and directory (F1-F8), marker (F11-F15), stale threshold (F36), worker agreement (V9), count resolution (V8-V12), budget (V13), project disagreement (V15). A test that needs one refusal must satisfy the earlier ones. For example a slot-disagreement test must give agreeing worker caps and a pinned processor count, because the worker and budget checks run first.

**V17.** Host variables win in a pool. A project variable that disagrees is refused rather than obeyed. In pool-less mode project variables win and host variables are ignored.

### 4.5 Slots versus workers

**V18.** The slot count and the worker count are one decision: slots times workers is at most the host's processors. Example host: 24 threads, 6 slots, 4 workers; or 7 and 3.

### 4.6 Processor count source

**V19.** Processor count is read at most once per invocation from the platform's online-processor query (a portable one; `nproc` is not POSIX, `/proc/cpuinfo` is Linux-only). A test seam overrides it (section 8); the seam is inert when empty.

### 4.7 Stale threshold interaction

**V20.** Stale threshold parsing: digits only (default 600 when unset or empty), else exit 2 naming the variable. Under a pool, below 600 is exit 2 naming the variable and value and the 600 floor. Exactly 600 is accepted. Without a pool a lower value is a per-project decision and works.

### 4.8 The worker-cap resolver (for test runners)

A small function a test-runner configuration calls to learn the per-run worker cap. Unit-testable without loading a runner config.

**V21.** Inputs are the environment and the processor count (both injectable). Output is a positive integer, or "no cap" (undefined) when neither variable is set. No cap means the runner keeps its own default exactly as today.

**V22.** Source selection: `GATE_LOCK_WORKERS` if present in the environment (including present but empty), else `GATE_HOST_WORKERS` unless empty (empty means unset), else no cap. A project variable that is set but empty or unusable is REFUSED and never falls through to the host's value. An operator who typed it deserves to be told, not to have it vanish and another value take its place. The asymmetry is deliberate: a project variable is the operator's own hand; a host variable is a wrapper's.

**V23.** Validation of whichever variable supplied the value: it MUST match all digits (no sign, no point, no spaces, no hex or exponent form) and be at least 1. Refused examples: `0`, `-1`, `4.5`, empty, `x`, `4`, `0x4`. The error message names the variable that actually supplied the value (not the other one) and says the value must be a positive whole number, and that it is set host-wide beside the slot variable (the project slot variable when the project variable supplied it, the host slot variable when the host one did).

**V24.** A value above the processor count is refused with a message naming the variable, the value and the processor count, and saying that a cap above the thread count is not a cap. It is refused rather than clamped. The processor count here is the runtime's own (the thread count the process can see), which on a container or cpuset can differ from the host's reading; this is the layer that enforces it.

**V25.** A value equal to the processor count is accepted. A leading zero (`04`) is a valid spelling of four.

**V26.** When both variables are set and valid, the project one wins and the two are NOT compared by the resolver. The comparison lives in the lock tool (V9), which is the layer that knows whether a pool is in use. Refusing in the resolver would break a host mid-migration.

**V27.** Wiring: the runner configuration passes the resolver's result as its max-workers setting; no cap leaves it undefined; the host's value reaches the setting when the project sets none; the project's value reaches it when set. A runner-level override variable that bypasses the validated setting (applied afterwards, with a bare integer parse) MUST NOT be set beside it, because it silently wins and leaves the validated number ignored.

**V28 (optional).** Offer the resolver as a CLI subcommand (print the cap, or print nothing) so non-JavaScript runners can use the same rules.

---

## 5. Concurrency and race guarantees

Each item is a numbered requirement that at least one test must prove. Where the original made a window testable by a pause hook, the hook is named generically (section 8).

**R1. Atomic creation.** A slot is created by filling a candidate directory completely (all six files) and renaming it onto the slot name. At no instant is a partially written slot visible at the name. A creator paused between the last write and the rename leaves no slot at the name and a complete candidate (owner, pid and beat present) beside it; on resume it completes atomically and leaves no candidate.

**R2. Create loses cleanly.** Two creators for the same name: exactly one wins; the loser exits busy (75), naming the winner, and leaves no candidate. A rename onto an existing directory in POSIX `mv` semantics moves the source INSIDE the destination and exits 0. The implementation MUST detect that case, remove its own nested candidate from the holder's slot and report not-won. A retrying busy caller MUST NOT grow a directory per attempt inside the holder's lock, however many slots and attempts. If the implementation uses a rename primitive with no-replace semantics (so nesting cannot happen), the observable result is the same.

**R3. Reclaim arbitration.** Two acquirers that both judge a slot reclaimable are arbitrated by the rename: only one wins. The loser re-inspects and ends busy or takes the freed name.

**R4. Reclaim versus retake.** A reclaimer that renamed a slot different from the one it judged (judged: dead or stale holder; moved: a fresh holder's replacement) MUST NOT delete it. After the move it re-reads owner, pid and beat of what it holds and deletes only if all three equal the judged values. Otherwise: name free means it renames the slot back (exit busy 75 for the acquirer in the original test, with a stderr line saying the reclaim was aborted and what was restored); name taken (a third party took it meanwhile) means it leaves the moved slot aside and untouched, prints a line saying the copy was left and never deleted, and the replacement at the name stays intact. The restored or left-aside slot's contents are byte-for-byte what its holder wrote.

**R5. Conditional give-back.** Whenever an acquirer gives back a slot it won (same-worktree refusal, slot-output failure), it removes the slot only if owner and pid are still this invocation's. If the name was taken over between the same-worktree scan and the removal by a contender who judged the abandoned slot reclaimable, the contender's lock is left intact, and the refusal answer the caller gets is unchanged.

**R6. Reader never sees an empty or missing beat.** For the whole life of a run that heartbeats every second, a reader hammering the beat file (thousands of reads, under both signal shells) sees zero empty and zero missing reads. The beat is replaced by rename.

**R7. Release waits for an in-flight refresh.** A heartbeat refresh parked between staging its beat and renaming it, when `run` is signalled, must not be raced by the removal: the slot is still present after the signal until the refresh completes, the run then releases and exits 143 with an empty stderr (no "directory not empty"). Unforced, this race failed 13/200 under bash-as-sh and 18/200 under dash.

**R8. Signals.** (a) INT yields 130 and TERM 143. (b) The command is stopped through a forwarded TERM and the signal exit code is not the command's. (c) The command is reaped before the lock is released: a command that takes seconds to tear down (traps TERM, sleeps 2 seconds, writes a marker, exits) has written its marker before the slot disappears. (d) The heartbeat loop and any in-flight refresh are reaped before exit. (e) A second signal (same or different, INT or TERM, 500 ms later, during the forwarding wait or the release wait) does not kill `run` mid-cleanup: `run` survives it, still releases, still prints the released line, exits with the first signal's code, and leaves nothing. (f) Behaviour is identical under bash-in-POSIX-mode and dash: bash defers the second TERM and re-enters its handler after the command is reaped (so the exit trap never ran, leaving a lock with its heartbeat looping); dash re-enters at once. The two signals are therefore ignored once the first is handled. (g) A signal reaches the command even when it is a plain shell (INT/QUIT ignore inheritance, C39).

**R9. Signal between acquire and recording.** TERM to `run` after the slot exists on disk but before `run` has set its held flag still releases the slot and exits 143 with the slot gone and no command started.

**R10. `.format` publication race.** Two acquirers held inside the window between writing the temp file and the link both complete, each takes one slot of a two-slot pool (different worktrees, so neither is refused as same-worktree), exactly one marker with `1` results, and no temp file remains.

**R11. Same-worktree under reordering.** The same-worktree rule holds against a holder in a higher-numbered slot, a lower one, and a holder that appeared between two acquires. Double-yield (both lose, neither runs) is acceptable; two simultaneous gates in one worktree is not.

**R12. Pin versus planted decoys.** A holder acting on its pin cannot be diverted by a planted directory that sorts first, carries the same owner and pid, and is canonical, non-canonical or symlinked.

**R13. One pid, one slot.** See F67.

**R14. Pool displacement.** A pool in a parent another user can write could be renamed away and replaced by a directory they own; the parent check (F4) and ancestor walk (F5) forbid that configuration, and refusals leave nothing created.

**R15. Lost-lock detection while running.** A command that deletes or replaces its own slot (a stand-in for a reclaim) is stopped by the heartbeat loop within about one heartbeat period (test uses 1 second), the run exits non-zero with the lost-lock message, the command's completion marker is absent, the command's pid is dead, and the replacement slot is left in place.

**R16. Stale holder cannot touch the replacement.** After a reclaim, the old holder's release is refused, whether it gets the owner right and the pid wrong, or the pid right and the owner wrong. The replacement stays. The rightful holder still releases.

**R17. Abandoned slot.** A slot directory with an owner file and no pid or beat is reclaimed after bounded patience (at pass 3), not mid-write (creation is atomic so it cannot be mid-write).

**R18. Huge numbers are never "busy".** A slot count of 20 or 30 digits is refused as over the ceiling, not run through a failing numeric comparison that falls through into the slot loop and reports an idle host as busy for ever.

**R19. Per-slot passes.** The pass counter is per slot, so five passes without winning a name on one slot are five on that slot, not spread across the host.

**R20. Nested run.** A run inside a run loses with 75 and cannot steal or deadlock.

**R21. Caller-level (informative).** A runner signalled while its acquire child is running still releases the lock the child went on to win (by reading the slot-output file); a second TERM while its release is parked still releases and says so; a TERM while it is stopping its heartbeat still gives the lock back; a TERM during a captured step reports the release on the runner's original stdout, not in the step's redirected capture.

---

## 6. Threat and test catalogue

Every test in the original suite, restated as a numbered requirement in neutral words. Group labels are navigational only. A "scratch" below means a fresh private temp directory per test, with a physically resolved path, so no test touches a real lock.

### 6.A Process and basics

**T1.** The script file must parse as plain POSIX shell (a syntax-only check with the system `sh` succeeds with empty output). If the rewrite is not a shell script, an equivalent portability gate applies to whatever it ships.

**T2.** `acquire` with an explicit caller pid exits 0, prints an `acquired by <lane>` line, and the slot holds that lane label, that pid, a positive start time and a positive beat.

**T3.** `acquire` with no caller pid exits 2 with stderr that names the caller-pid variable and recommends `run`, and creates nothing, whether the host is free or the slot is held by a live holder (in which case the holder's slot is untouched, not reclaimed, not reported as busy).

**T4.** `acquire` from a working directory that has been removed under the running process exits 2 with the message "cannot determine the caller's worktree", leaves no slot and no candidate. (The test deletes the child's own cwd after the child has started, because a missing cwd cannot be passed at spawn time.)

**T5.** A live holder (alive pid, fresh beat) makes `acquire` exit 75 with `busy` and the holder's lane label on stderr, and the holder's slot is exactly as found.

**T6.** A slot whose pid is dead is reclaimed by `acquire`: exit 0, stdout contains `reclaiming` and `not alive`, the slot now holds the new lane and pid.

**T7.** A slot whose beat is older than ten minutes (700 seconds in the test) while its pid is alive is reclaimed: exit 0, stdout contains `reclaiming` and `stale`, the new lane holds it.

**T8.** The stale-threshold override works in both directions: a widened threshold (3600) makes the same 700-second-old beat fresh, so acquire exits 75 and the holder stays; a tightened one (60) reclaims a beat the default would call fresh.

**T9.** A non-numeric stale threshold exits 2, naming the variable, and is reported as itself rather than as the bare-acquire refusal (the call has two faults and configuration is reported first).

**T10.** An abandoned slot with only an owner file (no pid, no beat) is reclaimed, exit 0, `reclaiming` on stdout, new lane holds it.

**T11.** An unknown subcommand exits 2 and prints usage on stderr.

### 6.B Creation and reclaim races

**T12.** A creator paused just before its rename (test hook) leaves no slot at the name; a candidate directory exists with owner, pid and beat; on resume exit 0, `acquired by` printed, the slot holds the lane and pid, no candidate left.

**T13.** A creator paused before its rename loses the name to a contender that acquires meanwhile (exit 0); the paused creator then exits 75, naming the contender's lane on stderr; the contender's slot is intact; no candidates leak.

**T14.** Reclaim restore: a reclaimer that judged a stale slot, paused, and then renamed a replacement that appeared in the window, exits 75 with `busy` and `reclaim aborted` on stderr; the replacement is back at the name with its owner and pid as written; no `reclaim` aside remains.

**T15.** Reclaim leave-aside: as T14, but a third party takes the name while the reclaimer is paused again before its restore; the reclaimer exits 75 with `never deleted` on stderr; the name holds the third party's slot intact; exactly one aside remains and holds the replacement's owner.

**T16.** A busy acquire against two held slots (slot count 2), repeated three times with different caller pids, exits 75 each time and leaves each holder's directory containing exactly the four original files (no nested candidate).

### 6.C Heartbeat, status, release, verify

**T17.** `heartbeat` with the caller's pid moves the beat past the seeded value (1000) and exits 0; `heartbeat` against an empty host exits non-zero with stderr containing `no lock`.

**T18.** `heartbeat` from a pid that is not the slot's holder is refused (non-zero, `heartbeat refused`), and the beat is unchanged.

**T19.** `status` on an empty host exits 0 and says `free`; with a live holder it shows the lane and `alive`; with a dead holder it says `not alive`.

**T20.** `release` by the holder removes the slot, exit 0, prints `released`; a second release is a clean no-op (exit 0, `nothing to release`).

**T21.** After a reclaim, the old holder's release is refused (non-zero, `release refused`) and the replacement stays, both when the owner is right but the pid is dead's pid and when the pid is right but the lane is wrong; the true holder's release then succeeds and the slot is gone.

**T22.** A release that cannot remove the slot (slot directory made read-only) is non-zero, stderr contains `release failed`, the slot remains.

### 6.D `run`

**T23.** While the command runs, the slot records the lane and `run`'s own pid (even when an unrelated caller pid is in the environment), a contender gets 75 with `busy`, the holder's slot is unchanged by the contender, and when the command ends the run exits 0 and the slot is gone.

**T24.** The heartbeat loop moves the beat above the start time while the command runs (period 1 second, bounded polling inside the command, not a single timed read), the run exits 0 with an empty stderr, and stdout contains `heartbeat pid`.

**T25.** The beat is never empty or missing under hammering, under both shells (R6), and the run then exits 143 when TERMed.

**T26.** TERM to `run` exits 143, prints `released by <lane>`, removes the slot, reaps the heartbeat pid, and kills the command (its pid is dead afterwards), under both shells, within a five-second budget.

**T27.** INT to `run` exits 130 with the same cleanup, and the command is also stopped (this proves INT is forwarded as TERM).

**T28.** Two TERMs, 500 ms apart, still release, reap and exit 143. (The second may find `run` already gone for a command that dies at once; a signal to a dead pid is a timing fact, not a failure.)

**T29.** Two INTs likewise exit 130.

**T30.** A signalled run holds the lock until a slow-to-stop command (traps TERM, sleeps two seconds, writes a marker) has actually finished: marker exists, slot gone, command dead, for TERM (143) and INT (130), under both shells.

**T31.** A second signal during that teardown still releases and reaps, exit 143/130 respectively.

**T32.** A command's own exit status is `run`'s exit status (exit 3 yields 3) and the slot is still released.

**T33.** A command that replaces the slot with another holder's makes `run` exit non-zero with `verify failed`, `FAILED to release the lock` and `release refused` on stderr, and the replacement is intact.

**T34.** A command that deletes or replaces its slot while it keeps running is stopped by the heartbeat loop: run exit non-zero, stderr contains `the lock was lost while the command ran`, the command's pid is dead, its completion marker absent, the replacement slot remains. Under both shells.

**T35.** A release waits for an in-flight heartbeat refresh (R7): after TERM the slot is still present 1.5 seconds later (the parked refresh holds it), then, when released, exit 143, stderr empty, `released by` printed, slot gone, heartbeat dead. Both shells.

**T36.** A second TERM while the release is waiting on the loop leaves `run` alive after the second signal, the slot still present, then released: stderr empty, exit 143, `released by` printed, slot gone, heartbeat dead. Both shells.

**T37.** A command that deletes the slot and exits makes `run` exit non-zero with `verify` and `no lock` and `FAILED to release the lock` on stderr (verification catches what an idempotent release does not).

**T38.** A nested run exits 75, with `busy` and the outer lane on stderr, never starts the inner command, and the outer run still removes the slot.

**T39.** The command's arguments pass through intact, including two arguments with spaces and a later `--` (which is a command argument), under both shells.

**T40.** Usage errors for `run`: no `--`, nothing after `--`, no lane, a stray word before `--`; each exit 2 with usage and nothing locked.

**T41.** A signal between acquire and held flag release (R9) exits 143, slot gone.

**T42.** A zero heartbeat period exits 2 naming the variable and "at least one second", with no lock taken.

**T43.** A non-numeric heartbeat period exits 2 naming the variable, before any lock is taken.

### 6.E Slots (project count)

**T44.** A count that is not a number, or zero, exits 2 before any lock (naming the variable; "at least one slot" for zero).

**T45.** Over-ceiling counts (`65`, `065`, a 20-digit and a 30-digit number) exit 2 with exactly one stderr line in the required shape (V5), the value as given, and no lock. The ceiling itself (64) is accepted and takes slot 0. `064` is accepted as 64 (proved by a live holder in slot 0 pushing the acquirer to slot 1). `0` and `00` get the exact "at least one slot" line.

**T46.** Three `run`s in three different worktrees at slot count 3 hold slots 0, 1, 2 at once (each recording its own run pid and its worktree; which lane wins which slot is a race and is not asserted), a fourth is told 75 with `busy` and the first holder's lane, the fourth slot never appears, all three slots are intact, and on completion each run removes only its own slot.

**T47.** With slot 0 held live and slot 1's holder dead, an acquire at count 3 reclaims slot 1 (naming its path in the reclaiming line), leaves slot 0's lane and pid alone, and does not touch slot 2. Slots are tried in order, judgement per slot.

**T48.** `status` at count 1 lists every existing slot, including slot 1, and none of four planted transient directories (a candidate and a reclaim directory for the base slot and for slot 1, each with a full set of lock files), and does not modify them.

**T49.** Release, verify and heartbeat without a pin act only on the caller's own slot: verify finds each holder's own slot and refuses a stranger pid with `verify failed`; heartbeat moves only the caller's slot's beat; release removes only the caller's slot and names it. (Rev 2, plan D7: an unpinned release by a pid that owns no slot exits 0 with `nothing to release` and removes nobody's; a release pinned to a slot held by another holder is refused with `release refused`.)

**T50.** A one-slot caller can take a free slot 0 even though slot 1 is held by someone else, is not made busy by it, and its release drops slot 0 only.

### 6.F One gate per worktree

**T51.** A second acquire from a subdirectory of the same git worktree is refused 75 naming `same worktree`, the first holder's lane, its slot path and the worktree root (the root, not the subdirectory); the refused one's slot is gone; the holder has exactly its six files; and the worktree identity written by the holder is the repository root.

**T52.** Two acquires from two different plain directories (outside any repository) both succeed (slots 0 and 1) and each records its own physically resolved directory as its worktree.

**T53.** A live same-worktree holder in a HIGHER slot blocks: the acquirer wins free slot 0, finds the higher-slot holder, gives slot 0 back, exits 75 naming `same worktree`, the holder's lane and the holder's slot path; the holder is untouched.

**T54.** A same-worktree holder that is dead (reaped pid) or stale (700-second-old beat) in the slot the loop will reclaim does not block: acquire exits 0 and the acquirer owns slot 0.

**T55.** The same, with the corpse in ANOTHER slot the loop never visits (slot 1, while slot 0 is free): acquire exits 0 on slot 0, the corpse is still there untouched, and stdout does not contain `reclaiming`. (This test exists because the first one only measures the reclaim path, leaving the liveness filter in the worktree scan unproven.)

**T56.** Give-back safety (R5): with the acquirer paused between the scan and the give-back (hook), the slot it won is removed and a contender's slot (different lane and pid) seeded at that name; on resume, acquire still exits 75 `same worktree`, the contender's slot is intact, and the original holder's slot is intact.

**T57.** A holder with no `worktree` file (only four files) never blocks: acquire at slot count 2 takes slot 1 while slot 0's four-file live holder remains.

**T58.** A same-worktree refusal does not write the slot-output file (checked against a control run on a host with no same-worktree holder, which does write it with the slot path) and leaves no slot of the refused caller.

### 6.G Forged slots and pins

**T59.** Planted directories at non-canonical names (`.0` and `.007`) that carry a real holder's owner and pid and sort before slot 1 are invisible to `status` and to an unpinned heartbeat: the real slot's beat moves, the plants' beats stay at their seeded value, an unpinned verify answers about the real slot, and the plants are not removed.

**T60.** A symlink at a canonical name, pointing at a directory the user owns holding a lock nobody wrote, is invisible to `status` and unpinned heartbeat: the real slot beats, the link target's beat does not move.

**T61.** A slot not owned by the expected uid is invisible: with the uid seam naming a foreign uid, `status` reports free and an unpinned heartbeat fails with `no lock`, and the beats stay at the seeded value; without the seam both slots show up. Proves the seam, not a filter that hides everything.

**T62.** A pinned heartbeat refreshes the pinned slot (slot 1) and not decoys at slot 0 and slot 2 that carry the same owner and pid.

**T63.** Four bad pins (a `.0` name, a `.64` name, a symlink at a canonical name, a real slot judged under a foreign uid seam) are each refused by verify, heartbeat and release with exit 2 and a message naming the pin path; no action is taken (the real slot's beat is unchanged, the slot and the link target still exist).

**T64.** The wrapped command sees no pin variable at all, not the inherited one and not `run`'s own; `run` takes slot 0 even though the inherited pin named slot 1; the slot is released on exit.

**T65.** A uid seam set but EMPTY is inert (falls back to the real uid), so an exported-but-empty override does not hide every slot and make a held host read as free.

**T66.** A heartbeat on a pid that appears in two slots, with the pin set to the second, refreshes only the pinned one.

**T67.** An acquire from a pid that already holds an answering slot at slot count 3 exits 2 with `already holds` and the slot path, takes neither slot 1 nor slot 2, and leaves the first slot unchanged (the refusal happens before the slot loop).

**T68.** The same pid's slot with a stale beat is reclaimed instead of refused: exit 0, `reclaiming` and `stale`, and the beat is newer.

### 6.H Pool: directory rules

**T69.** At pool count 2, two acquires from two worktrees put slot 0 and slot 1 in the pool under the pool's own names, nothing named like a lock appears in the temp directory, and the slot holds the six files (including `worktree` and `project`).

**T70.** A missing pool directory is created with mode 0700 (exactly, regardless of umask) and `.format` holding `1`, and the only entry whose name starts with `.format` is `.format` itself.

**T71.** An existing `.format` holding `1\n` is accepted with empty stderr and is not rewritten (the file's bytes are unchanged).

**T72.** A `.format` holding `2`, or an empty file, is refused (exit 2) with stderr containing "lock format" and the value (the word "nothing" for empty) and "this gate speaks 1"; the pool afterwards contains only `.format`.

**T73.** A pool owned by someone else (through the pool uid seam, with the parent seam pinned to the real uid) is refused (exit 2); the message names the pool path (as `GATE_LOCK_DIR=<path>`) and "owned by uid <seam>", does NOT mention the parent, and the pool is left empty (no marker, no slot).

**T74.** A group-writable (0775) or world-writable (0777) pool is refused (exit 2), stderr contains "neither group- nor world-writable", the pool is left empty. (Mode is set after creation to defeat the umask.)

**T75.** A symlinked pool is refused (exit 2) naming `GATE_LOCK_DIR=<link>` and "not a symlink", the target is left empty; a relative pool path is refused naming the value and "must be an absolute path".

**T76.** A pool path that is not plain (`<link>//pool`, `<link>/./pool`, `<link>/../pool`), or that runs through a symlinked ancestor (`<link>/below/pool`), is refused (exit 2) before anything is created: no `pool` appears in the link target, nor in `below`. The ancestor refusal names the link component, the phrase "is a symlink", and the hint to name the pool by its resolved path (cd and `pwd -P`). The plain-path refusal says "plain absolute path". A real nested pool two real levels down is accepted with empty stderr and gets a marker.

**T77.** A symlinked ancestor reached through a symlink alias to a real directory is refused with the hint, and nothing is created through the link; the same pool named by its resolved path is accepted. (Regression guard: macOS temp paths run through a symlinked `/var`, so a pool built from the unresolved temp path was refused 26 times in the original; a Linux-only run cannot see it.)

**T78.** A symlinked pool cannot be smuggled in behind a trailing slash: the link plus none, one or two slashes is refused (exit 2), stderr contains `GATE_LOCK_DIR=<link> is` (the reduced path) and "not a symlink", and the target is left empty.

**T79.** A real pool with trailing slashes keeps the same slot paths byte for byte: the `acquired ... at <path>` line and the busy line quote the unslashed slot path whichever trailing-slash spelling each caller used; the root `/` is refused with "not the filesystem root".

**T80.** A pool whose parent is group- or world-writable (0775, 0777) is refused (exit 2) with stderr containing "GATE_LOCK_DIR's parent <parent>" and "not writable by group or others", and the pool is NOT created; a foreign-owned parent (parent uid seam 65534) is refused naming the parent and "owned by uid 65534" and the pool is not created; a symlinked parent is refused naming the parent; an ordinary 0700 parent is accepted, empty stderr, with a marker.

**T81.** An EMPTY pool variable behaves exactly as unset: the slot lands in the temp directory under the default name, with the lane recorded, and no `.format` anywhere.

### 6.I Pool: counts and budgets

**T82.** `GATE_HOST_SLOTS` alone is the pool's count and is parsed as a slot count: `6` and `006` accepted, empty accepted (the project count decides), `0`, `65`, `x` refused (exit 2) with stderr naming `GATE_HOST_SLOTS`.

**T83.** Slot derivation: 24 processors and 4 workers is 6 slots; 24 and 5 is 4; 3 and 4 is 1. Proved by the only observable: a project slot count equal to the derived count is accepted, one above is refused naming both the project slot variable and `GATE_HOST_WORKERS`, one below (when above 1) is refused, and zero (in the one-slot case) is refused as not a count without reaching the comparison. The worker-cap variable is stated beside the host's so the worker comparison does not intercept.

**T84.** A pool of six derived slots really runs six gates at once and refuses the seventh: six acquires from six worktrees with six live holder pids succeed, a seventh from a seventh worktree is 75 with `busy` and the first lane (a distinct seventh live pid is used so the one-pid-one-slot refusal does not intercept), and the pool then holds exactly `.format` and the six slot names.

**T85.** The budget check: 6 and 4 on 24 processors accepted; 7 and 4 refused (28 greater than 24); 6 and 5 refused (30 greater than 24); refusals name `GATE_HOST_SLOTS=<n>`, `GATE_HOST_WORKERS=<n>` and "24 processors". A non-numeric processor count refuses with the system query's name, `GATE_HOST_SLOTS=6 with GATE_HOST_WORKERS=4` and "checked against". `GATE_HOST_SLOTS=24` alone with 24 processors is accepted with empty stderr (V14).

**T86.** A non-numeric processor count refuses the derivation (exit 2): stderr contains `GATE_HOST_WORKERS=4`, the system query's name and "derive a slot count".

**T87.** A project slot count of 3 beside `GATE_HOST_SLOTS=6` (with matching workers and a pinned 24-processor host) is refused under a pool (exit 2) naming the project variable and value, `GATE_HOST_SLOTS` and the pool path; the pool then holds only `.format` (the marker is published before counts are compared). The same numbers with NO pool follow the old precedence: the project count wins, no refusal, three held slots mean 75 `busy` with no "does not match" message, and no fourth slot name appears.

**T88.** A project worker cap that disagrees with the host's (3 versus 4) is refused (exit 2) naming both with their values; the agreeing case with slots 6, workers 4 on a pinned 24-processor host succeeds.

**T89.** Two spellings of one worker cap are one cap: project `04` beside host `4` is accepted (stderr empty), project `3` beside host `4` is refused naming both, and host `04` beside project `4` is accepted.

**T90.** A stale threshold of 60 is refused under a pool (exit 2) naming the variable with its value and "600s"; the same value without a pool works (exit 0); 600 under a pool is accepted.

**T91.** `status` prints the project name per slot (`<slot> held by <lane> project <name>` contiguous) and `unknown` for a slot with no project file, which is still listed rather than skipped.

**T92.** At the heartbeat pause hook, the staged beat file is a sibling of the slot inside the pool, named after the pool slot base with a `beatnew` segment and a pid, and nothing is staged in the temp directory and no project lock lives there; afterwards the pool holds only `.format`. Pool and temp directory are deliberately different directories in this test, so the assertion can tell "beside the lock" from "happened to land there".

**T93.** Two acquirers racing into an absent pool (R10): both complete with exit 0, slots are exactly slot 0 and slot 1, exactly one `.format` containing `1`, no temp file, and both slots released after the commands end.

### 6.J Worker-cap resolver

**T94.** Unset returns "no cap" (the runner's default applies).

**T95.** A whole number passes through (4 gives 4); a count equal to the CPU count (24) is accepted.

**T96.** Refused with the project variable's name: `0`, `-1`, `4.5`, empty, `x`, `4`, `0x4`.

**T97.** A count above the CPU count (25 versus 24) is refused with a message saying the variable and value are above this host's available parallelism (24).

**T98.** The host variable is the cap when the project variable is unset (4 gives 4); the project variable wins when both are set (2 beside 4 gives 2) and they are not compared.

**T99.** A project variable that is set but empty or unusable is refused ("must be a positive whole number, got ''"), not answered from the host.

**T100.** An EMPTY host variable is unset (equals the absent case, no cap), and never displaces a project variable (project 3 with empty host gives 3).

**T101.** `0`, `4.5`, `x` in the host variable are refused naming the host variable; 25 versus 24 is refused naming the host variable and the processor count.

**T102.** Runner wiring: setting the project variable (to 1 so any runner reaches it) puts 1 into the runner's max-workers; unset leaves it undefined; with only the host variable set the host's value reaches it. The test clears the host variable while stubbing the project one, otherwise a host that adopted the pool passes the wiring test with the wiring deleted.

### 6.K Caller (runner) behaviours worth carrying as interface tests

These came from the runner's own tests, restated because they define what the lock must permit.

**T103.** A runner signalled twice while its release is parked still releases and says so (exit 143).

**T104.** A runner signalled while its acquire child is running still releases the slot the child won (the slot-output file names it); the slot is gone and the pin file is removed.

**T105.** A runner signalled while stopping its heartbeat still gives the lock back.

**T106.** A runner signalled during a captured step reports its release on the caller's original stdout.

**T107.** A lock the runner took but could not name (slot path never recorded) is still released, with a failure message.

**T108.** A green runner reports the release once and never a refusal.

**T109.** A busy runner prints one line and nothing else on a refused acquire and exits 75.

### 6.L Isolation of the test environment itself

**T110.** The test environment builder deletes the three host variables rather than overriding them, pins the project slot count to 1 and points the temp directory at a per-test scratch; every spawn site uses it. Otherwise a host that has adopted the pool silently loses a seat while the suite runs, and the test still passes its own assertions.

**T111.** The scratch directory used by tests is physically resolved (the real path), because a symlinked temp path (macOS) would make every pool test fail the ancestor walk. Symlinks built on purpose for refusal tests are created inside a resolved scratch so the link is the only one in the path.

**T112.** Signal tests run under both the system `sh` and the explicit `dash` where present; CI's `sh` is dash and macOS's is bash in POSIX mode, and the two differ in what they defer and when.

**T113.** Tests of liveness use a really-dead pid (spawn a child, reap it, reuse the number) and a really-alive pid that is not the test process when one process must not be treated as a second slot for the same holder (a long `sleep` child).

---

## 7. Platform notes

**L1. Linux, dash.** The shell is POSIX `sh`; do not use bash features, `$PPID` as a liveness source (dash sets it, but callers must pass the caller pid explicitly), zsh, fractional sleeps (BSD and GNU differ; waits use whole seconds), or `mv -n`. A shell trap on a foreground child does not run until that child exits (dash defers it for the whole of `sleep 30`), so anything that must react to a signal while waiting runs as a background job and is waited for; sleeps inside loops are also backgrounded and waited for.

**L2. Job-control and signal inheritance.** In a non-interactive shell, an asynchronous command starts with INT and QUIT ignored and keeps that. Use TERM to stop children. Do not enable job control.

**L3. macOS.** `/tmp` and `/var` are symlinks (to `/private/...`). The default temp directory lives behind `/var/folders/...`. A pool path built from it contains a symlink above the pool and is refused by F5. The operator fix, and the one the refusal message gives, is to name the pool by its physical path (`cd <dir> && pwd -P`). Test scratch directories and the worktree identity fallback use the physical working directory for the same reason. `mv -n` is not atomic on macOS. File ownership and mode are read as attributes via `find` predicates because POSIX `sh` has no portable `stat`.

**L4. tmpfs under `/run/user/<uid>`.** The recommended pool location is a per-user runtime directory: local tmpfs, owner-only (0700), owned by the user. To survive logout it needs the user session to linger (for systemd, `loginctl enable-linger <user>`). The pool is therefore lost on reboot, which is fine since holders do not survive a reboot either. Do not use the system temp directory (shared and writable), a union filesystem, NFS or an overlay as the pool.

**L5. Pid namespace.** Every client of one pool shares one pid namespace. A container that sees different pids reads live host holders as dead and reclaims them. A containerised gate must run the tool inside the same pid namespace as the others, or not share the pool.

**L6. Beat staging filesystem.** The staged beat and the slot share a filesystem by construction (sibling files in the pool). Do not stage it on the temp directory, which may be a different filesystem from the pool.

**L7. Clock.** Time is epoch seconds from the system clock; no monotonic source is used. Clock steps can make a beat appear in the future (not stale) or very old (stale).

**L8. Optional git.** The worktree identity prefers the git top-level of the working directory and falls back to the physical working directory. A linked worktree resolves to its own root, not the main checkout's.

**L9. Process-liveness probe.** Signal-zero on the recorded pid. Other tools in the same family warn this answers "permission denied" for another uid's process as a locale-dependent message; this tool treats any failure as not alive (Q3).

**L10. Whole-second waits.** Pause and patience waits use one-second sleeps; tests must allow for about one second of latency between removing a hook marker and the process continuing.

---

## 8. Test hooks (seams the implementation must offer)

All seams are inert when unset AND when set to an empty string (an exported-but-empty value must mean what never-set means, otherwise a wrapper that always sets it turns every slot invisible). Name them `GATE_LOCK_TEST_*`. They exist only to make races and signal windows deterministic. A production build SHOULD allow them to be compiled out or gated (Q20).

### 8.1 Pause hooks

Generic mechanism: when the variable holds a path, at the named point the process creates (touches) that file, then blocks, polling once a second, for as long as the file exists. A test waits for the file to appear (the handshake), performs the action it wants in that window, then deletes the file to release the process.

**H1.** Before-format-link: between writing the temp marker and linking it; reached only when `.format` does not exist (the only state in which two acquirers can overlap).

**H2.** Before-create-rename: after the candidate is fully written, before it is renamed onto the slot name.

**H3.** After-inspect: after a reclaimer has judged a slot reclaimable and announced it, before it renames the slot aside.

**H4.** Before-restore: after the reclaimer has moved a mismatching slot aside and detected the mismatch, before it tries to rename it back.

**H5.** Before-same-worktree-give-back: after the same-worktree scan found a rival, before the conditional removal of the slot just won.

**H6.** After-acquire: in `run`, after the acquire has created the slot and before the held flag is set.

**H7.** Before-release: in release, after the owner/pid check, before the removal. Opens the window in which a second signal used to kill the process.

**H8.** Before-beat-rename: in heartbeat, after the staged beat is written, before the rename. Lets a test hold one refresh in flight across a signal and release (R7, R8).

**H9.** Runner-level (informative): before each locked step; in the runner's heartbeat loop's TERM handler (touch a marker saying the handler is running, then wait until a named file appears, then exit; waiting for appearance rather than disappearance makes re-entry harmless); and a flag that makes the runner act as if the acquire had recorded no slot.

### 8.2 Value seams

**H10.** Expected-uid override: the uid slots and the pool leaf must be owned by. Default current uid. Empty is inert.

**H11.** Parent-uid override: the uid the pool's parent must be owned by. Default: the leaf's value. Separate from H10 so each ownership claim can be made foreign alone (otherwise the parent is judged first and the pool's own owner refusal is unreachable from a test).

**H12.** Processor-count override: replaces the system's online-processor query. Empty is inert. Non-numeric values are used to test the refusal paths.

### 8.3 Requirements on the test harness itself

**H13.** Hooks are deterministic: a test never relies on timing luck. Each race requirement R-numbered above names the hook that parks the window.

**H14.** Every spawn site in the suite builds its environment through one function (T110).

---

## 9. Open questions (behaviour that looks accidental or under-specified)

**Q1.** Pool-less mode keeps legacy names and semantics (the lock in the temp directory, no marker, project variables win, host variables ignored). Should a new package keep it, or require a pool always (with a default under a per-user runtime directory)? The legacy mode's slot base name is not `gate.lock` in the original and was only ever shared with one project; the neutral name chosen here (`gate.lock`) changes it.

**Q2.** The marker's temp file name is not in the frozen transient list, and a publisher killed between writing and linking leaves it forever. The frozen list should include it, and a cleanup rule is needed.

**Q3.** Liveness uses a signal-zero probe; a live process owned by another user answers "not permitted", which the probe reads as dead. A sibling tool in the same repository warns about exactly this and uses a process-table lookup instead. For one-user pools it is moot; for sudo or multiple uids it would reclaim live holders. Decide.

**Q4.** Staleness is `>=` threshold and a future beat is never stale. A holder (or a skewed clock) writing a far-future beat is immortal while its pid lives. Should future beats beyond some skew be treated as stale?

**Q5.** Numeric handling of stale threshold, beat, pid and processors uses shell integer comparison; a 20-digit beat or threshold would produce "Illegal number" and fall through. Only slot and worker counts have the digit-length guard. Extend the guard, or bound all numeric inputs.

**Q6.** The runner's failure marker file is named from the process id in the shared temp directory (predictable, possibly a world-writable parent). A private directory or a secure temp file would be safer; format 1 does not say.

**Q7.** An unpinned release by a caller that holds nothing judges slot 0, so the answer is exit 0 ("nothing to release") if slot 0 is absent but exit 1 ("release refused") if slot 0 is held by someone else. That asymmetry is incidental.

**Q8.** The pass-3 patience for a missing pid or beat and the pass-5 contention exit are tuned by hand: total worst-case wait per slot is under a few seconds, but five passes against a hot reclaim storm may turn a reclaimable slot into "busy". Is that desired?

**Q9.** Configuration checks run before the usage check, so a bad configuration with a bad subcommand reports the configuration, and `status` fails on bad configuration even though it only reads. Intentional (one resolution per invocation), but not stated as a requirement in the original.

**Q10.** Nothing watches the heartbeat loop's own death (C45); a supervisor that outlives the loop is needed to close it, and the only candidate pid is the one liveness already judges. Open design problem.

**Q11.** Renaming onto an empty existing slot directory. With POSIX `mv` semantics an empty directory at the slot name makes the candidate nest inside it, treated as busy, then reclaimed after pass 3. With `rename(2)` an empty target directory is replaced silently. A rewrite using `rename(2)` or a no-replace rename must decide whether to keep that bounded-patience behaviour.

**Q12.** The conditional give-back and release both check owner and pid and then remove the slot as two steps; a slot replaced between the check and the removal is deleted (a time-of-check/time-of-use window). The reclaim path closes the same shape by renaming aside first and verifying. Should release and give-back do the same?

**Q13.** Same-worktree identity is a string compare of the git top-level or the physical path. Submodules, bare repositories, case-insensitive filesystems, symlinked checkouts and bind mounts can give two names for one tree, or one name for two. Out of scope for format 1, but worth a note on whether the identity should include a device and inode.

**Q14.** Lane labels are free text; a label with a newline, trailing newlines, or characters that break the single-line files is trimmed on read by command substitution, so owner comparisons drop trailing newlines. Should the label's charset be validated at acquire?

**Q15.** HUP and QUIT are not handled by `run`. A hangup (terminal closed) kills `run` without cleanup, leaving the command orphaned and the slot reclaimable only by pid death. SIGKILL is documented as the escape from a stuck command; HUP is simply unhandled.

**Q16.** Aside directories left by an aborted reclaim, candidate directories left by a creator killed at the wrong moment, and staged beat files left by a killed heartbeat are never cleaned by anything, and a pid recycle can even clear a stale same-named candidate by chance. A janitor rule (age-based removal of transients, bounded by pid liveness) is needed for long-lived pools.

**Q17.** The format only supports one uid per pool (0700 pool, ownership check on every slot). If the host runs lanes as several users, a shared pool is impossible by design; say so, or extend the format.

**Q18.** The wrapped command's exit status and the tool's own statuses share the number space (a command that exits 75 or 2 is indistinguishable by code alone; the stderr busy line is the tiebreaker, C44). A dedicated status-file or reserved range would remove the ambiguity.

**Q19.** `status` in a pool with no slots names only slot 0's path in its "free" line; it does not say the pool is empty or how many slots exist. The output carries no count or capacity line.

**Q20.** Test hooks are present in the production binary and are consulted on every acquire and release. Should they be compiled out, or gated behind one master switch, so a stray exported variable in an operator's environment cannot park a production gate?

**Q21.** The pin file path (`GATE_LOCK_SLOT_OUT`) is trusted: the tool writes to whatever path is named. A hostile caller environment could aim it at a file the user owns. Not covered by the original.

**Q22.** (Rev 2: resolved by plan D22: a set-but-empty or unusable project variable is refused in both the tool and the resolver; an empty host variable means unset.) The worker-cap resolver and the lock tool both read the project and host worker variables but disagree on emptiness for the project variable (the resolver refuses an empty project variable, the lock tool treats empty as unset when comparing). A unified rule would remove the surprise.
