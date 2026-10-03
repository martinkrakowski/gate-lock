import os from 'node:os';

/** The on-disk format number this package speaks. */
export const FORMAT = 1;

const DIGITS = /^[0-9]+$/;

function stripZeros(digits) {
  return digits.replace(/^0+(?=.)/, '');
}

/**
 * The per-run worker cap a test-runner configuration should use (spec V21-V26).
 * `GATE_LOCK_WORKERS` wins when it is present, even when empty; otherwise
 * `GATE_HOST_WORKERS` unless it is empty; otherwise there is no cap (undefined).
 * A value must be a positive whole number no larger than the processor count.
 * A bad project value is refused, never answered from the host (D22). The two
 * variables are not compared here; that belongs to the lock tool (V26).
 *
 * `gate-lock workers` applies the same rules and prints the same messages.
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {number} [cpus] the processor count; defaults to os.availableParallelism()
 * @returns {number | undefined}
 */
export function resolveMaxWorkers(env = process.env, cpus = os.availableParallelism()) {
  let name;
  let slotVar;
  if (env.GATE_LOCK_WORKERS !== undefined) {
    name = 'GATE_LOCK_WORKERS';
    slotVar = 'GATE_LOCK_SLOTS';
  } else if (env.GATE_HOST_WORKERS !== undefined && env.GATE_HOST_WORKERS !== '') {
    name = 'GATE_HOST_WORKERS';
    slotVar = 'GATE_HOST_SLOTS';
  } else {
    return undefined;
  }
  const raw = env[name];
  const digits = DIGITS.test(raw) ? stripZeros(raw) : '0';
  if (digits === '0') {
    throw new Error(
      `${name} must be a positive whole number, got '${raw}'; the worker cap is set host-wide, beside ${slotVar}`,
    );
  }
  if (BigInt(digits) > BigInt(cpus)) {
    throw new Error(
      `${name}=${raw} is above this host's available parallelism (${cpus}); a cap above the thread count is not a cap`,
    );
  }
  return Number(digits);
}
