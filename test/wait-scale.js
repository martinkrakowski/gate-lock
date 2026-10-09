/**
 * How much longer than its written deadline a wait in this suite may take.
 *
 * The suite's waits are handshakes with a deadline: a file appears, a process is
 * gone, a beat has moved. The deadlines were written for an idle machine. On a
 * loaded one, and on the macOS CI runner in particular, a handshake that takes
 * 200 ms alone can take longer than its ten seconds while other test files fork
 * shells on the same cores, and the test then fails although nothing is wrong.
 *
 * A scale stretches every such deadline by the same factor. It changes only how
 * long a test WAITS before it gives up, never what it accepts: a handshake that
 * arrives is still checked the same way, and a handshake that never arrives still
 * fails, later. Three under CI, one elsewhere; `GATE_LOCK_TEST_WAIT_SCALE` sets it.
 */
const fromEnv = Number(process.env.GATE_LOCK_TEST_WAIT_SCALE);
export const WAIT_SCALE =
  Number.isFinite(fromEnv) && fromEnv >= 1 ? fromEnv : process.env.CI ? 3 : 1;

/** A deadline in milliseconds, stretched by the scale. */
export function scaled(ms) {
  return Math.round(ms * WAIT_SCALE);
}
