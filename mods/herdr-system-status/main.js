// The status bar: machine, branch and agents on the left — the shipped
// workspace-status's behavior, rebuilt — and system metrics with a VS Code
// style status message on the right. Clicking the metrics opens a popover
// with the last five minutes of CPU and GPU as trend lines.
//
// Samples every 5 s with exec: /proc/stat (CPU), /proc/meminfo (RAM),
// `df -kP /` (disk) and `nvidia-smi` (GPU; absent silently when it isn't
// there). Warns in red when a metric crosses a threshold. The popover also
// names the hardware: the CPU's `model name` from /proc/cpuinfo (read once)
// and the GPU's `name` from nvidia-smi.

import { h_flex, v_flex } from "gpui-base";
import { View, div, svg } from "gpui-kit";
import { agents, exec, openOverlay, props, setShared, shared, spaces, theme } from "herdr";

const TICK = 5000; // sample cadence, ms
const HISTORY = 60; // trend lines keep one sample per tick: 5 minutes
const WARN = 90; // percent where CPU, RAM and GPU turn the message red
const DISK_FREE_WARN = 10; // warn when free disk space drops below this %
const STATE = "herdr-system-status"; // shared() key: the bar publishes, the popover reads

export default class SystemStatus extends View {
  /**
   * @param {import("gpui-shell").Props | undefined} _props
   * @param {import("gpui-kit").AsyncContext} cx
   */
  init(_props, cx) {
    // A trends popup is a fresh copy of this mod: its own state is empty, so
    // it only reads the snapshot the bar copy publishes — it never samples.
    if (props()?.trends) return;
    /** @type {{ at: number, total: number, busy: number } | null} */
    this.prevCpu = null; // previous /proc/stat sample
    /** @type {number | null} */
    this.cpu = null; // busy percent 0..100, null until the second tick
    /** @type {{ pct: number, usedGb: number, totalGb: number } | null} */
    this.ram = null;
    /** @type {{ pctUsed: number, freePct: number } | null} */
    this.disk = null;
    /** @type {{ pct: number, vramUsedGb: number, vramTotalGb: number, model: string | null } | null} */
    this.gpu = null; // null when nvidia-smi is absent
    this.gpuFails = 0; // consecutive nvidia-smi failures
    /** @type {string | null} */
    this.cpuModel = null; // `model name` from /proc/cpuinfo, read once
    this.gpuNext = 0; // no earlier nvidia-smi retry than this unix ms
    /** @type {number[]} */
    this.cpuHistory = [];
    /** @type {number[]} */
    this.gpuHistory = [];
    cx.timer.every(TICK, (cx) => this.refresh(cx));
    this.refresh(cx);
  }

  /** @param {import("gpui-kit").AsyncContext} cx */
  async refresh(cx) {
    const [stat, mem, df] = await Promise.all([
      exec("cat", ["/proc/stat"]),
      exec("awk", ["/^(MemTotal|MemAvailable|MemFree)/ {print $1, $2}", "/proc/meminfo"]),
      exec("df", ["-kP", "/"]),
    ]).catch(
      /** @returns {(import("herdr").ExecResult | null)[]} */
      () => [null, null, null],
    );

    if (stat && stat.code === 0) this.readCpu(stat.stdout, Date.now());
    if (mem && mem.code === 0) this.readRam(mem.stdout);
    if (df && df.code === 0) this.readDisk(df.stdout);

    // The CPU's make/model never changes: read it once, on the first tick.
    if (!this.cpuModel) {
      try {
        const c = await exec("grep", ["-m1", "model name", "/proc/cpuinfo"]);
        const v = c.code === 0 ? c.stdout.split(":").slice(1).join(":").trim() : "";
        if (v) this.cpuModel = v;
      } catch {
        /* absent silently, like the rest of the /proc metrics */
      }
    }

    // GPU only when its tool answers; after three misses back off a minute.
    if (Date.now() > this.gpuNext) {
      try {
        const g = await exec("nvidia-smi", [
          "--query-gpu=utilization.gpu,memory.used,memory.total,name",
          "--format=csv,noheader,nounits",
        ]);
        const parts = g.stdout
          .trim()
          .split("\n")[0]
          .split(",")
          .map((s) => s.trim());
        const f = parts.slice(0, 3).map(parseFloat);
        if (g.code === 0 && parts.length >= 3 && !f.some(isNaN)) {
          this.gpu = {
            pct: Math.round(f[0]),
            vramUsedGb: Math.round((f[1] / 1024) * 10) / 10,
            vramTotalGb: Math.round((f[2] / 1024) * 10) / 10,
            model: parts.slice(3).join(", ") || null, // names never contain commas, but just in case
          };
          this.gpuFails = 0;
          this.gpuNext = 0;
        } else this.gpuMiss();
      } catch {
        this.gpuMiss();
      }
    }

    this.cpuHistory.push(this.cpu ?? 0);
    if (this.gpu) this.gpuHistory.push(this.gpu.pct);
    else if (this.gpuHistory.length) this.gpuHistory.push(0);
    while (this.cpuHistory.length > HISTORY) this.cpuHistory.shift();
    while (this.gpuHistory.length > HISTORY) this.gpuHistory.shift();

    setShared(STATE, {
      cpu: this.cpu,
      cpuModel: this.cpuModel,
      ram: this.ram,
      disk: this.disk,
      gpu: this.gpu,
      cpuHistory: this.cpuHistory,
      gpuHistory: this.gpuHistory,
    });
    cx.notify();
  }

  /**
   * @param {string} out
   * @param {number} at
   */
  readCpu(out, at) {
    const line = out.split("\n").find(/** @param {string} l */ (l) => l.startsWith("cpu "));
    if (!line) return;
    const p = line.trim().split(/\s+/).slice(1).map(Number);
    const busy = p[0] + p[1] + p[2] + p[5] + p[6] + p[7]; // user nice sys irq softirq steal
    const idle = p[3] + p[4]; // idle + iowait
    const total = busy + idle;
    if (this.prevCpu && at - this.prevCpu.at > 1000) {
      const dt = total - this.prevCpu.total;
      if (dt > 0) this.cpu = Math.max(0, Math.min(100, Math.round((100 * (busy - this.prevCpu.busy)) / dt)));
    }
    this.prevCpu = { at, total, busy };
  }

  /** @param {string} out */
  readRam(out) {
    const v = /** @type {Record<string, number>} */ ({});
    for (const l of out.split("\n")) {
      const [name, kb] = l.trim().split(/\s+/);
      if (name && kb) v[name.replace(":", "")] = parseInt(kb, 10);
    }
    const total = v.MemTotal;
    const avail = v.MemAvailable ?? v.MemFree;
    if (total > 0 && avail != null) {
      const usedKb = Math.max(0, total - avail);
      this.ram = {
        pct: Math.round((100 * usedKb) / total),
        usedGb: Math.round((usedKb / 1048576) * 10) / 10,
        totalGb: Math.round((total / 1048576) * 10) / 10,
      };
    }
  }

  /** @param {string} out */
  readDisk(out) {
    const cols = out.trim().split("\n").pop().split(/\s+/);
    const totalK = parseInt(cols[1], 10),
      usedK = parseInt(cols[2], 10),
      availK = parseInt(cols[3], 10);
    if (totalK > 0) {
      this.disk = {
        pctUsed: Math.round((100 * usedK) / totalK),
        freePct: Math.round((100 * availK) / totalK),
      };
    }
  }

  gpuMiss() {
    this.gpuFails++;
    if (this.gpuFails >= 3) {
      this.gpu = null; // omitted silently; a working nvidia-smi brings it back
      this.gpuNext = Date.now() + 60000;
    }
  }

  summary() {
    const parts = [];
    if (this.cpu != null) parts.push(`CPU ${this.cpu}%`);
    if (this.ram) parts.push(`RAM ${this.ram.pct}%`);
    if (this.gpu) parts.push(`GPU ${this.gpu.pct}%`);
    if (this.disk) parts.push(`DISK ${this.disk.pctUsed}%`);
    return parts.join("  ·  ");
  }

  warns() {
    const w = [];
    if (this.cpu != null && this.cpu > WARN) w.push(`CPU ${this.cpu}%`);
    if (this.ram && this.ram.pct > WARN) w.push(`RAM ${this.ram.pct}%`);
    if (this.gpu && this.gpu.pct > WARN) w.push(`GPU ${this.gpu.pct}%`);
    if (this.disk && this.disk.freePct < DISK_FREE_WARN) w.push(`Disk ${this.disk.freePct}% free`);
    return w;
  }

  openTrends() {
    // Width must be explicit: Herdr sizes a spec-less overlay by measuring the
    // mod without these props — which renders the status bar (~420px), not
    // this view — so the popup comes out 120px too wide. The height is omitted
    // and adapts to the content. The anchor keeps the popup just above the
    // status bar: at the pointer it clips off the bottom edge.
    // Each model line is ~13px of text plus its 4px gap above.
    /** @param {string | null} m */
    const sub = (m) => (m ? 17 : 0);
    const est = 20 + 57 + 13 + sub(this.cpuModel) + (this.gpu ? 30 + 1 + 57 + sub(this.gpu.model) : 10); // p + CPU row + hint, plus gaps + divider + GPU row

    let at;
    try {
      const v = window.viewport_size();
      at = { x: Math.max(8, v.width - 316), y: Math.max(8, v.height - est - 38) };
    } catch {
      /* no viewport: fall back to the pointer */
    }

    openOverlay({
      kind: "popup",
      mod: "herdr-system-status",
      props: { trends: true },
      width: 300,
      ...(at ? { at } : {}),
    });
  }

  /** @param {import("gpui-kit").Context} _cx */
  render(_cx) {
    if (props()?.trends) return this.renderTrends();
    return this.renderBar();
  }

  renderBar() {
    const t = /** @type {Record<string, import("gpui-kit").Color>} */ (theme());
    const space = spaces().find((s) => s.active);
    const list = agents();
    const needs = list.filter((a) => a.status === "blocked").length;
    const warns = this.warns();

    /** @param {string} icon @param {string} text */
    const label = (icon, text) =>
      h_flex()
        .gap(6)
        .items_center()
        .child(svg(`mods/workspace-chrome/${icon}.svg`).size(13))
        .child(text);

    return h_flex()
      .size_full()
      .px(14)
      .gap(16)
      .items_center()
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(11.8)
      .text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), (el) => el.child(label("branch", space.branch)))
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .child(div().size(6).rounded(3).bg(t.dim))
          .child(`${list.length} agents`)
          .when(needs > 0, (el) => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))),
      )
      .child(div().flex_1())
      .child(
        h_flex()
          .id("sys-status")
          .gap(6)
          .items_center()
          .cursor_pointer()
          .whitespace_nowrap()
          .on_click(() => this.openTrends())
          .tooltip("System status — click for CPU/GPU trend lines")
          .when(warns.length > 0, (el) => el.text_color(t.blocked).child(warns.join("  ·  ")))
          .when(warns.length === 0 && this.summary(), (el) => el.child(div().child(this.summary())))
          .when(warns.length === 0 && !this.summary(), (el) => el.child("…")),
      );
  }

  renderTrends() {
    const t = /** @type {Record<string, import("gpui-kit").Color>} */ (theme());
    const s = /** @type {SystemStatusSnapshot} */ (shared(STATE) ?? {});

    // The chart well: the popover's color blended 35% toward the theme's
    // background — slightly darker in a dark theme, slightly lighter in a
    // light one, so the chart reads as an inset without hard-coding a color.
    /**
     * @param {string} a
     * @param {string} b
     * @param {number} f
     */
    const mix = (a, b, f) => {
      /** @param {string} c */
      const h = (c) => (/^#[0-9a-fA-F]{6}$/.test(c) ? [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)) : null);
      const A = h(a),
        B = h(b);
      return A && B
        ? `#${[0, 1, 2]
            .map((i) =>
              Math.round(A[i] * (1 - f) + B[i] * f)
                .toString(16)
                .padStart(2, "0"),
            )
            .join("")}`
        : t.hover;
    };

    // A cast is needed: template expressions widen to plain `string`, and the
    // style surface demands a `#${string}` — and mix produces one by
    // construction (each channel is two hex digits).
    const well = /** @type {import("gpui-kit").Color} */ (mix(t.popover, t.background, 0.35));
    /**
     * @param {number[]} data
     */
    const chart = (data) =>
      div()
        .p(6)
        .rounded(6)
        .bg(well)
        .child(
          h_flex()
            .h(28)
            .gap(1)
            .items_end()
            .children(
              data.map((v) =>
                div()
                  .w(3)
                  .h(Math.max(2, Math.round((v / 100) * 28)))
                  .rounded(1)
                  .bg(t.accent),
              ),
            ),
        );

        /**
     * @param {number[]} data
     * @param {string} label
     * @param {string | null | undefined} model
     */
    const spark = (data, label, model) =>
      v_flex()
        .gap(2)
        .child(div().text_size(11).text_color(t.muted).child(label))
        .child(chart(data))
        .when(Boolean(model), (el) => el.child(div().truncate().text_size(10).text_color(t.muted).child(model)));

        return v_flex()
      .p(10)
      .gap(4)
      .bg(t.popover)
      .border(1)
      .border_color(t.border)
      .rounded(8)
      .w(280)
      .when(!s.cpuHistory?.length, (el) =>
        el.child(div().text_size(11).text_color(t.muted).child("Gathering samples…")),
      )
      .when(Boolean(s.cpuHistory?.length), (el) => el.child(spark(s.cpuHistory, `CPU  ${s.cpu ?? "--"}%`, s.cpuModel)))
      .when(Boolean(s.gpu), (el) => el.child(div().h(1).bg(well)))
      .when(Boolean(s.gpu), (el) =>
        el.child(
          spark(
            s.gpuHistory,
            `GPU  ${s.gpu.pct}%  ·  VRAM ${s.gpu.vramUsedGb}/${Math.round(s.gpu.vramTotalGb)} GB`,
            s.gpu.model,
          ),
        ),
      );
  }
}
