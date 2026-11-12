// Type declarations for herdr-system-status, next to main.js.
//
// main.js stays JavaScript (that is all the runtime loads); this file exists
// only for `tsc --checkJs` and the editor. It declares the one contract that
// spans two running copies of the view: `shared("herdr-system-status")` —
// the bar copy publishes a snapshot every 5 s tick, the trends popup reads
// it, and neither shares a class to type against.

/**
 * What the status-bar copy publishes through `setShared(STATE, ...)` every
 * tick, and what the trends popup casts `shared(STATE)` to. Every metric is
 * null until its first sample lands: the popup renders "Gathering samples…"
 * on an empty `cpuHistory`, and omits the GPU block entirely while the GPU
 * is null (nvidia-smi absent, or backing off after three misses).
 */
declare interface SystemStatusSnapshot {
  /** Busy percent 0..100, null until the second /proc/stat sample. */
  cpu: number | null;
  /** `model name` from /proc/cpuinfo, read once, null if grep found nothing. */
  cpuModel: string | null;
  /** Memory from /proc/meminfo, null until the first successful awk. */
  ram: { pct: number; usedGb: number; totalGb: number } | null;
  /** Root disk from `df -kP /`, null until the first successful df. */
  disk: { pctUsed: number; freePct: number } | null;
  /** GPU from nvidia-smi, null whenever the tool doesn't answer. */
  gpu: {
    pct: number;
    vramUsedGb: number;
    vramTotalGb: number;
    /** The GPU's `name`; null when nvidia-smi printed none. */
    model: string | null;
  } | null;
  /** One sample per 5 s tick, oldest first, capped at HISTORY (60) entries. */
  cpuHistory: number[];
  /** Same cadence as cpuHistory; zeros while the GPU is unavailable. */
  gpuHistory: number[];
}
