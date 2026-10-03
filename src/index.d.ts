/** The on-disk format number this package speaks. */
export declare const FORMAT: 1;

/**
 * The per-run worker cap for a test-runner configuration (spec V21-V26), or
 * undefined when neither GATE_LOCK_WORKERS nor GATE_HOST_WORKERS is set.
 * Throws an Error for an unusable value or one above the processor count.
 * `cpus` defaults to `os.availableParallelism()`: what this process may use.
 *
 * Processor sources differ on purpose. This resolver, and `gate-lock workers`
 * (which tries `nproc` first, then `getconf _NPROCESSORS_ONLN`), enforce the
 * count the runner can really spend (affinity, cpusets). The lock tool's own
 * slot derivation and budget check (V11, V13) use the host's online count,
 * `getconf _NPROCESSORS_ONLN`.
 */
export declare function resolveMaxWorkers(
  env?: Record<string, string | undefined>,
  cpus?: number,
): number | undefined;
