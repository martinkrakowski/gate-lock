/** The on-disk format number this package speaks. */
export declare const FORMAT: 1;

/**
 * The per-run worker cap for a test-runner configuration (spec V21-V26), or
 * undefined when neither GATE_LOCK_WORKERS nor GATE_HOST_WORKERS is set.
 * Throws an Error for an unusable value or one above the processor count.
 * `cpus` defaults to `os.availableParallelism()`.
 */
export declare function resolveMaxWorkers(
  env?: Record<string, string | undefined>,
  cpus?: number,
): number | undefined;
