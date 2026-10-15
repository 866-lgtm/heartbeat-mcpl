/** The longest wait setTimeout holds: 2^31-1 ms, about 24.8 days. Asked for
 *  longer, Node warns (TimeoutOverflowWarning) and waits 1 ms instead. */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/** Call `onDue` once the clock reaches `dueAt` (epoch ms), however far off it
 *  is: wait in steps no longer than MAX_TIMEOUT_MS, and check the clock on each
 *  wake. `onDue` always runs from a timer, never synchronously, even when
 *  `dueAt` has passed (setTimeout waits 1 ms for a negative delay). Returns a
 *  function that cancels whichever step is pending. */
export function callAt(dueAt: number, onDue: () => void): () => void {
  let timer: ReturnType<typeof setTimeout>;
  const arm = (): void => {
    timer = setTimeout(() => (Date.now() < dueAt ? arm() : onDue()), Math.min(dueAt - Date.now(), MAX_TIMEOUT_MS));
  };
  arm();
  return () => clearTimeout(timer);
}
