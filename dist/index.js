// @bun
// src/index.ts
import { VERSION } from "@oh-my-pi/pi-coding-agent";

// src/tui/panel.ts
import { getKeybindings, matchesKey as matchesKey2, routeSgrMouseInput } from "@oh-my-pi/pi-tui";
import { OverlayPanel, PanelDivider, PanelRows } from "@oh-my-pi/pi-tui/chrome";
import { stripTerminalSequences as stripTerminalSequences2, visibleWidth as visibleWidth13, wrapTextWithAnsi as wrapTextWithAnsi9 } from "@oh-my-pi/pi-tui";
import { ensureThemeSync, theme as activeTheme } from "@oh-my-pi/pi-tui/theme";

// src/data/client.ts
import { resolve } from "path";

// src/workers/process.ts
import { getActiveProfile, getAgentDir } from "@oh-my-pi/pi-utils";
function spawnStatsWorker(path, purpose, stdin = "ignore") {
  const searchPath = process.env.PATH;
  const bun = searchPath ? Bun.which("bun", { PATH: searchPath }) : null;
  if (!bun) {
    throw new Error(`${purpose} requires standalone Bun. Install Bun and ensure \`bun\` is available on PATH, then restart omp.`);
  }
  const profile = getActiveProfile() ?? "";
  return Bun.spawn([bun, "run", path], {
    env: {
      ...process.env,
      PI_BUNDLED: "",
      PI_CODING_AGENT_DIR: getAgentDir(),
      OMP_PROFILE: profile,
      PI_PROFILE: profile
    },
    stdin,
    stdout: "pipe",
    stderr: "pipe"
  });
}

// src/data/client.ts
class StatsReadClient {
  #child = null;
  #pending = new Map;
  #sequence = 0;
  #closed = false;
  #malformedLines = 0;
  #stderr = "";
  #writeError;
  #spawn;
  #live;
  #serviceError;
  #listeners = new Set;
  constructor(spawn = () => spawnStatsWorker(resolve(import.meta.dir, "./data-worker.js"), "Stats reads", "pipe")) {
    this.#spawn = spawn;
  }
  fetch(needs, range, stage) {
    return this.#request({ type: "fetch", needs, range }, stage);
  }
  api(path, params = {}, options = {}) {
    return this.#request({ type: "api", path, params, ...options });
  }
  subscribe(status, error) {
    const listener = { status, error };
    this.#listeners.add(listener);
    if (this.#live)
      status(this.#live);
    if (this.#serviceError)
      error?.(this.#serviceError);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  requestSync() {
    return this.#request({ type: "sync" });
  }
  #request(input, stage) {
    if (this.#closed)
      return Promise.reject(new Error("Stats panel closed"));
    try {
      let child = this.#child;
      if (!child) {
        child = this.#spawn();
        this.#child = child;
        this.#live = undefined;
        this.#serviceError = undefined;
        this.#stderr = "";
        this.#malformedLines = 0;
        this.#writeError = undefined;
        this.#watch(child);
      }
      const id = ++this.#sequence;
      const result = Promise.withResolvers();
      this.#pending.set(id, { resolve: result.resolve, reject: result.reject, stage });
      this.#write(child, { ...input, id });
      return result.promise;
    } catch (error) {
      return Promise.reject(error);
    }
  }
  async#write(child, request) {
    try {
      const stdin = child.stdin;
      if (typeof stdin === "number" || !stdin)
        throw new Error("Stats read worker stdin unavailable");
      stdin.write(JSON.stringify(request) + `
`);
      await stdin.flush();
    } catch (error) {
      if (this.#child !== child)
        return;
      this.#writeError = error;
      child.kill("SIGKILL");
    }
  }
  async#watch(child) {
    const stderr = (async () => {
      const reader = child.stderr.getReader();
      const decoder = new TextDecoder;
      while (true) {
        const { value, done } = await reader.read();
        if (done)
          break;
        this.#stderr = (this.#stderr + decoder.decode(value, { stream: true })).slice(-8192);
      }
      this.#stderr = (this.#stderr + decoder.decode()).slice(-8192);
    })().catch((error) => {
      child.kill("SIGKILL");
      throw error;
    });
    const stdout = (async () => {
      const reader = child.stdout.getReader();
      const decoder = new TextDecoder;
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        if (done)
          buffer += `
`;
        let end;
        while ((end = buffer.indexOf(`
`)) !== -1) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          if (!line.trim())
            continue;
          let message;
          try {
            message = JSON.parse(line);
          } catch {
            this.#malformedLines++;
            this.#stderr = (this.#stderr + `
malformed worker stdout line ${this.#malformedLines}: ${line.slice(0, 200)}`).slice(-8192);
            if (this.#malformedLines > 10)
              throw new Error(`Stats read worker emitted ${this.#malformedLines} malformed stdout lines`);
            continue;
          }
          this.#receive(message);
        }
        if (done)
          break;
      }
    })().catch((error) => {
      child.kill("SIGKILL");
      throw error;
    });
    const results = await Promise.allSettled([stdout, stderr, child.exited]);
    if (this.#child !== child)
      return;
    this.#child = null;
    const failure = results.find((result) => result.status === "rejected");
    const exit = results[2];
    const diagnostic = failure?.status === "rejected" ? String(failure.reason) : this.#writeError !== undefined ? String(this.#writeError) : `Stats read worker exited (code ${exit.status === "fulfilled" ? exit.value : "unknown"})`;
    const error = new Error(diagnostic + (this.#stderr ? `
${this.#stderr}` : ""));
    for (const pending of this.#pending.values())
      pending.reject(error);
    this.#pending.clear();
    if (!this.#closed) {
      this.#serviceError = error;
      for (const listener of this.#listeners)
        listener.error?.(error);
    }
  }
  #receive(message) {
    if (this.#closed)
      return;
    if (!("id" in message)) {
      this.#live = message.status;
      this.#serviceError = undefined;
      for (const listener of this.#listeners)
        listener.status(message.status);
      return;
    }
    const pending = this.#pending.get(message.id);
    if (!pending)
      return;
    if ("stage" in message) {
      pending.stage?.(message.stage);
      return;
    }
    this.#pending.delete(message.id);
    if ("error" in message)
      pending.reject(new Error(message.error));
    else
      pending.resolve(message.data);
  }
  close() {
    if (this.#closed)
      return;
    this.#closed = true;
    for (const pending of this.#pending.values())
      pending.reject(new Error("Stats panel closed"));
    this.#pending.clear();
    this.#listeners.clear();
    this.#child?.kill("SIGKILL");
  }
}

// src/tui/panel.ts
import { copyToClipboard } from "@oh-my-pi/pi-natives";

// node_modules/@oh-my-pi/omp-stats/src/client/data/colors.ts
var SERIES_COLORS = [
  "#5ad8e6",
  "#ed4abf",
  "#9d7bff",
  "#f5b54a",
  "#4ade80",
  "#5b8cff",
  "#ff7a59",
  "#2dd4bf",
  "#c3e94f",
  "#fb7185"
];
var OTHER_COLOR = "#6c6c74";
function modelKey(model, provider) {
  return `${model}::${provider}`;
}

// node_modules/@oh-my-pi/pi-utils/src/dates.ts
var MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December"
];
var WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
var TOKENS = [
  "MMMM",
  "yyyy",
  "EEEE",
  "MMM",
  "EEE",
  "yy",
  "MM",
  "dd",
  "HH",
  "hh",
  "mm",
  "ss",
  "M",
  "d",
  "H",
  "h",
  "m",
  "s",
  "a"
];
function pad(value, length = 2) {
  return String(value).padStart(length, "0");
}
function tokenValue(date, token) {
  const month = date.getMonth();
  const weekday = date.getDay();
  const hours = date.getHours();
  const hours12 = hours % 12 || 12;
  switch (token) {
    case "yyyy":
      return pad(date.getFullYear(), 4);
    case "yy":
      return pad(date.getFullYear() % 100);
    case "MMMM":
      return MONTHS[month];
    case "MMM":
      return MONTHS[month].slice(0, 3);
    case "MM":
      return pad(month + 1);
    case "M":
      return String(month + 1);
    case "dd":
      return pad(date.getDate());
    case "d":
      return String(date.getDate());
    case "EEEE":
      return WEEKDAYS[weekday];
    case "EEE":
      return WEEKDAYS[weekday].slice(0, 3);
    case "HH":
      return pad(hours);
    case "H":
      return String(hours);
    case "hh":
      return pad(hours12);
    case "h":
      return String(hours12);
    case "mm":
      return pad(date.getMinutes());
    case "m":
      return String(date.getMinutes());
    case "ss":
      return pad(date.getSeconds());
    case "s":
      return String(date.getSeconds());
    case "a":
      return hours < 12 ? "AM" : "PM";
  }
}
function asDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime()))
    throw new RangeError("Invalid time value");
  return date;
}
function format(value, pattern) {
  const date = asDate(value);
  let result = "";
  for (let index = 0;index < pattern.length; ) {
    if (pattern[index] === "'") {
      if (pattern[index + 1] === "'") {
        result += "'";
        index += 2;
        continue;
      }
      index++;
      while (index < pattern.length) {
        if (pattern[index] !== "'") {
          result += pattern[index++];
          continue;
        }
        if (pattern[index + 1] === "'") {
          result += "'";
          index += 2;
          continue;
        }
        index++;
        break;
      }
      continue;
    }
    const rest = pattern.slice(index);
    const token = TOKENS.find((candidate) => rest.startsWith(candidate));
    if (token) {
      result += tokenValue(date, token);
      index += token.length;
      continue;
    }
    const character = pattern[index++];
    if (/[A-Za-z]/.test(character)) {
      throw new RangeError(`Format string contains an unescaped latin alphabet character \`${character}\``);
    }
    result += character;
  }
  return result;
}

// node_modules/@oh-my-pi/omp-stats/src/client/data/formatters.ts
var NUMBER_LOCALE = "en-US";
function formatInteger(value) {
  return value.toLocaleString(NUMBER_LOCALE);
}
function formatCompact(value) {
  return value.toLocaleString(NUMBER_LOCALE, { notation: "compact" });
}
function formatCost(value, digits) {
  if (value === 0)
    return "$0";
  const fractionDigits = digits !== undefined ? digits : value > 0 && value < 0.01 ? 4 : 2;
  return `$${value.toLocaleString(NUMBER_LOCALE, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits
  })}`;
}
function formatEstimatedCost(value, unpricedRequests, digits) {
  return value === 0 && unpricedRequests > 0 ? "N/A" : formatCost(value, digits);
}
function isUnpricedMessage(message) {
  return message.usage.totalTokens > 0 && message.usage.cost.total === 0 && (message.provider === "xai-oauth" || message.costUnpriced === true);
}
function formatMessageCost(message, digits) {
  return formatEstimatedCost(message.usage.cost.total, isUnpricedMessage(message) ? 1 : 0, digits);
}
function formatPercent(value, digits = 1) {
  return `${(value * 100).toFixed(digits)}%`;
}
function formatDurationMs(value, digits) {
  if (value === null)
    return "-";
  const sec = value / 1000;
  const d = digits !== undefined ? digits : sec < 1 ? 2 : 1;
  return `${sec.toFixed(d)}s`;
}
function formatTokensPerSecond(value) {
  if (value === null)
    return "-";
  return value.toFixed(1);
}
function formatTimestamp(timestamp) {
  return format(new Date(timestamp), "MMM d, HH:mm:ss");
}

// node_modules/@oh-my-pi/omp-stats/src/client/data/view-models.ts
var AGENT_TYPE_ORDER = ["main", "subagent", "advisor"];
function sumConversationTokens(stats) {
  return stats.totalInputTokens + stats.totalOutputTokens + stats.totalCacheReadTokens + stats.totalCacheWriteTokens;
}
function buildAgentTokenShare(stats) {
  const byType = new Map;
  for (const stat of stats)
    byType.set(stat.agentType, stat);
  const present = AGENT_TYPE_ORDER.map((type) => byType.get(type)).filter((stat) => stat !== undefined);
  const totalTokens = present.reduce((sum, stat) => sum + sumConversationTokens(stat), 0);
  const totalCost = present.reduce((sum, stat) => sum + stat.totalCost, 0);
  const segments = present.map((stat) => {
    const tokens = sumConversationTokens(stat);
    return {
      agentType: stat.agentType,
      tokens,
      requests: stat.totalRequests,
      cost: stat.totalCost,
      share: totalTokens > 0 ? tokens / totalTokens : 0
    };
  });
  return { totalTokens, totalCost, segments };
}
function buildCostSummary(costSeries) {
  const summary = {
    totalCost: 0,
    requests: 0,
    unpricedRequests: 0,
    activeDays: new Set(costSeries.map((p) => p.timestamp)).size,
    avgDailyCost: 0,
    costInput: 0,
    costOutput: 0,
    costCacheRead: 0,
    costCacheWrite: 0,
    models: [],
    topModel: null
  };
  const byKey = new Map;
  for (const point of costSeries) {
    const key = modelKey(point.model, point.provider);
    let row = byKey.get(key);
    if (!row) {
      row = {
        key,
        model: point.model,
        provider: point.provider,
        cost: 0,
        requests: 0,
        unpricedRequests: 0,
        costInput: 0,
        costOutput: 0,
        costCacheRead: 0,
        costCacheWrite: 0,
        share: 0
      };
      byKey.set(key, row);
    }
    addCostPoint(row, point);
    addCostPoint(summary, point);
    row.cost += point.cost;
    summary.totalCost += point.cost;
  }
  summary.avgDailyCost = summary.activeDays > 0 ? summary.totalCost / summary.activeDays : 0;
  summary.models = [...byKey.values()].sort((a, b) => b.cost - a.cost || b.requests - a.requests || a.key.localeCompare(b.key));
  for (const row of summary.models)
    row.share = summary.totalCost > 0 ? row.cost / summary.totalCost : 0;
  const top = summary.models[0];
  summary.topModel = top !== undefined && top.cost > 0 ? top : null;
  return summary;
}
function addCostPoint(target, point) {
  target.costInput += point.costInput;
  target.costOutput += point.costOutput;
  target.costCacheRead += point.costCacheRead;
  target.costCacheWrite += point.costCacheWrite;
  target.requests += point.requests;
  target.unpricedRequests += point.unpricedRequests;
}
function buildModelPerformanceLookup(points) {
  const byKey = new Map;
  for (const point of points) {
    const key = modelKey(point.model, point.provider);
    let series = byKey.get(key);
    if (!series) {
      series = [];
      byKey.set(key, series);
    }
    series.push({
      timestamp: point.timestamp,
      avgTtftSeconds: point.avgTtft !== null ? point.avgTtft / 1000 : null,
      avgTokensPerSecond: point.avgTokensPerSecond,
      requests: point.requests
    });
  }
  for (const series of byKey.values())
    series.sort((a, b) => a.timestamp - b.timestamp);
  return byKey;
}
var TEMP_FOLDER_RE = /^\/?-?(?:private-)?(?:tmp|var-folders)(?:[-/]|$)/;
function buildFolderRows(folders) {
  let totalRequests = 0;
  let failedRequests = 0;
  let totalCost = 0;
  let unpricedRequests = 0;
  let conversationTokens = 0;
  let input = 0;
  let cacheRead = 0;
  let maxRequests = 0;
  let maxCost = 0;
  for (const f of folders) {
    totalRequests += f.totalRequests;
    failedRequests += f.failedRequests;
    totalCost += f.totalCost;
    unpricedRequests += f.unpricedRequests;
    conversationTokens += f.totalInputTokens + f.totalCacheReadTokens + f.totalCacheWriteTokens + f.totalOutputTokens;
    input += f.totalInputTokens;
    cacheRead += f.totalCacheReadTokens;
    if (f.totalRequests > maxRequests)
      maxRequests = f.totalRequests;
    if (f.totalCost > maxCost)
      maxCost = f.totalCost;
  }
  let temporaryCount = 0;
  const rows = folders.map((f) => {
    const temporary = TEMP_FOLDER_RE.test(f.folder);
    if (temporary)
      temporaryCount++;
    return {
      ...f,
      conversationTokens: f.totalInputTokens + f.totalCacheReadTokens + f.totalCacheWriteTokens + f.totalOutputTokens,
      requestShare: totalRequests > 0 ? f.totalRequests / totalRequests : 0,
      costShare: totalCost > 0 ? f.totalCost / totalCost : 0,
      temporary
    };
  });
  return {
    rows,
    totalRequests,
    failedRequests,
    totalCost,
    unpricedRequests,
    conversationTokens,
    cacheRate: input + cacheRead > 0 ? cacheRead / (input + cacheRead) : 0,
    maxRequests,
    maxCost,
    temporaryCount
  };
}
function buildToolRows(tools) {
  let calls = 0;
  let tokens = 0;
  let cost = 0;
  for (const t of tools) {
    calls += t.calls;
    tokens += t.totalTokensShare;
    cost += t.costShare;
  }
  return tools.map((t) => ({
    ...t,
    errorRate: t.calls > 0 ? t.errors / t.calls : 0,
    callFraction: calls > 0 ? t.calls / calls : 0,
    tokenFraction: tokens > 0 ? t.totalTokensShare / tokens : 0,
    costFraction: cost > 0 ? t.costShare / cost : 0,
    avgResultChars: t.calls > 0 ? t.resultChars / t.calls : 0
  }));
}
function requestStatus(row) {
  if (row.stopReason === "aborted")
    return "aborted";
  if (row.stopReason === "error" || row.errorMessage)
    return "failed";
  return "ok";
}
function quantile(sorted, q) {
  if (sorted.length === 0)
    return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}
function summarizeRequests(rows) {
  let failed = 0;
  let aborted = 0;
  let tokens = 0;
  let cost = 0;
  let unpriced = 0;
  let oldest = null;
  let newest = null;
  const durations = [];
  const ttfts = [];
  for (const row of rows) {
    const status = requestStatus(row);
    if (status === "failed")
      failed++;
    else if (status === "aborted")
      aborted++;
    tokens += row.usage.totalTokens;
    cost += row.usage.cost.total;
    if (isUnpricedMessage(row))
      unpriced++;
    if (row.duration !== null)
      durations.push(row.duration);
    if (row.ttft !== null)
      ttfts.push(row.ttft);
    if (oldest === null || row.timestamp < oldest)
      oldest = row.timestamp;
    if (newest === null || row.timestamp > newest)
      newest = row.timestamp;
  }
  durations.sort((a, b) => a - b);
  ttfts.sort((a, b) => a - b);
  return {
    requests: rows.length,
    failed,
    aborted,
    tokens,
    cost,
    unpriced,
    medianDuration: quantile(durations, 0.5),
    p95Duration: quantile(durations, 0.95),
    medianTtft: quantile(ttfts, 0.5),
    oldest,
    newest
  };
}
var SIGNATURE_MAX = 180;
var UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
var PREFIXED_ID_RE = /\b(?:req|msg|call|toolu|chatcmpl|resp|run|gen)[-_][A-Za-z0-9_-]{6,}/g;
var HEX_RE = /\b[0-9a-f]{12,}\b/gi;
var NUMBER_RE = /(?<![\w.-])\d+(?:\.\d+)?/g;
var HTTP_STATUS_RE = /^[1-5]\d\d$/;
function errorSignature(message) {
  if (!message?.trim())
    return "Unknown error";
  const normalized = message.replace(/\s+/g, " ").trim().replace(UUID_RE, "<id>").replace(PREFIXED_ID_RE, "<id>").replace(HEX_RE, "<hex>").replace(NUMBER_RE, (n) => HTTP_STATUS_RE.test(n) ? n : "N");
  return normalized.length > SIGNATURE_MAX ? `${normalized.slice(0, SIGNATURE_MAX - 1)}\u2026` : normalized;
}
function groupErrorsBySignature(rows) {
  const groups = new Map;
  for (const row of rows) {
    const signature = errorSignature(row.errorMessage);
    let group = groups.get(signature);
    if (!group) {
      group = {
        signature,
        count: 0,
        firstSeen: row.timestamp,
        lastSeen: row.timestamp,
        latest: row,
        models: [],
        byModel: new Map
      };
      groups.set(signature, group);
    }
    group.count++;
    if (row.timestamp < group.firstSeen)
      group.firstSeen = row.timestamp;
    if (row.timestamp > group.lastSeen) {
      group.lastSeen = row.timestamp;
      group.latest = row;
    }
    const key = modelKey(row.model, row.provider);
    const model = group.byModel.get(key);
    if (model)
      model.count++;
    else
      group.byModel.set(key, { model: row.model, provider: row.provider, count: 1 });
  }
  return [...groups.values()].map(({ byModel, ...group }) => ({
    ...group,
    models: [...byModel.values()].sort((a, b) => b.count - a.count || a.model.localeCompare(b.model))
  })).sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen);
}

// src/tui/features/core/shared.ts
import { truncateToWidth as truncateToWidth7, wrapTextWithAnsi as wrapTextWithAnsi3 } from "@oh-my-pi/pi-tui";

// src/tui/charts/time-series.ts
import { visibleWidth as visibleWidth2, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";

// src/tui/palette.ts
import { hexToRgb, rgbToHex } from "@oh-my-pi/pi-utils";
import { colorToAnsi } from "@oh-my-pi/pi-tui/theme/color";
var PALETTE = {
  primary: "accent",
  negative: "error",
  positive: "success",
  caution: "warning",
  heading: "text",
  label: "text",
  meta: "dim",
  muted: "muted",
  dim: "dim",
  faint: "borderMuted"
};
var SIDEBAR_INK = {
  headingActive: "text",
  headingInactive: "dim",
  rowActive: "text",
  rowHover: "text",
  rowInactive: "muted",
  iconActive: "accent",
  iconInactive: "dim",
  jumpKey: "borderMuted"
};
var TAB_INK = {
  active: "text",
  hover: "text",
  inactive: "dim",
  muted: "borderMuted",
  hint: "borderMuted"
};
var SELECTION_BG = {
  band: "selectedBg"
};
var SPAN_COLORS = {
  turn: "muted",
  model: "accent",
  tool: "warning",
  subagent: "mdLink",
  background: "borderMuted"
};
var SERIES_COLORS2 = [
  "accent",
  "success",
  "warning",
  "error",
  "mdCode",
  "mdLink",
  "syntaxString",
  "syntaxKeyword",
  "syntaxFunction",
  "syntaxNumber",
  "syntaxOperator",
  "syntaxVariable"
];
function resolveSeries(count, theme) {
  const palette = [];
  const seen = new Set;
  for (const color of SERIES_COLORS2) {
    const key = colorToAnsi(theme.getColorHex(color), theme.getColorMode());
    if (seen.has(key))
      continue;
    seen.add(key);
    palette.push(color);
    if (palette.length >= count)
      break;
  }
  if (palette.length === 0)
    palette.push("accent");
  const distinct = palette.length;
  while (palette.length < count)
    palette.push(palette[palette.length % distinct]);
  return palette.slice(0, count);
}
var HEAT_STOPS = [0.3, 0.5, 0.72, 1];
function heatRamp(theme, level) {
  const t = HEAT_STOPS[Math.max(0, Math.min(HEAT_STOPS.length - 1, Math.round(level)))];
  const text = hexToRgb(theme.getColorHex("text"));
  const from = { r: 255 - text.r, g: 255 - text.g, b: 255 - text.b };
  const to = hexToRgb(theme.getColorHex("accent"));
  return colorToAnsi(rgbToHex({
    r: Math.round(from.r + (to.r - from.r) * t),
    g: Math.round(from.g + (to.g - from.g) * t),
    b: Math.round(from.b + (to.b - from.b) * t)
  }), theme.getColorMode());
}

// src/tui/format.ts
var NUMBER_LOCALE2 = "en-US";
function formatInteger2(value) {
  return value.toLocaleString(NUMBER_LOCALE2);
}
function compactTokens(value) {
  return value.toLocaleString(NUMBER_LOCALE2, { notation: "compact" });
}
function formatCost2(value, digits) {
  if (value === 0)
    return "$0";
  const fractionDigits = digits !== undefined ? digits : value > 0 && value < 0.01 ? 4 : 2;
  return `$${value.toLocaleString(NUMBER_LOCALE2, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits
  })}`;
}
function costWithUnpriced(cost, unpricedRequests, digits) {
  const base = cost === 0 && unpricedRequests > 0 ? "N/A" : formatCost2(cost, digits);
  if (unpricedRequests === 0)
    return base;
  return `${base} \xB7 ${formatInteger2(unpricedRequests)} unpriced`;
}
function formatPercent2(value, digits = 1) {
  return `${(value * 100).toFixed(digits)}%`;
}
function cacheSavingsNote(cacheSavings) {
  if (cacheSavings === null)
    return "-";
  if (cacheSavings === 0)
    return "cache savings 0.0%";
  const percent = Math.abs(cacheSavings * 100).toFixed(1);
  return cacheSavings > 0 ? `cache saves ${percent}% vs billing the same input uncached` : `cache costs ${percent}% MORE than billing the same input uncached`;
}
function formatDurationMs2(value, digits) {
  if (value === null)
    return "-";
  const sec = value / 1000;
  const d = digits !== undefined ? digits : sec < 1 ? 2 : 1;
  return `${sec.toFixed(d)}s`;
}
function formatElapsed(ms) {
  if (ms < 60000)
    return formatDurationMs2(ms);
  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 60)
    return `${totalMin}m ${String(Math.floor(ms % 60000 / 1000)).padStart(2, "0")}s`;
  return `${Math.floor(totalMin / 60)}h ${String(totalMin % 60).padStart(2, "0")}m`;
}
function formatBytes(value) {
  if (value >= 1e9)
    return `${(value / 1e9).toFixed(1)} GB`;
  if (value >= 1e6)
    return `${(value / 1e6).toFixed(1)} MB`;
  if (value >= 1000)
    return `${(value / 1000).toFixed(1)} KB`;
  return `${value} B`;
}

// src/tui/glyphs.ts
var SPARK_LEVELS = 8;
var UNICODE_GLYPHS = {
  barFill: "\u2588",
  barEmpty: "\u2591",
  sparkRamp: ["\u2581", "\u2582", "\u2583", "\u2584", "\u2585", "\u2586", "\u2587", "\u2588"],
  heatCell: ["\u25A0", "\u25A0", "\u25A0", "\u25A0"],
  heatEmpty: "\xB7",
  columnGap: "\u2502",
  axisLine: "_",
  trendUp: "\u25B2",
  trendFlat: "\u2500",
  rowCursor: "\u25B6",
  legendKey: "\u25A0",
  pointHollow: "\u2022",
  pointFilled: "\u25CF",
  axisRule: "\u2500",
  plotSpine: "\u2502",
  trackMarker: "\u25C6",
  playhead: "\u25BC"
};
var ASCII_GLYPHS = {
  barFill: "#",
  barEmpty: ".",
  sparkRamp: [".", ":", "-", "=", "+", "*", "#", "@"],
  heatCell: [".", "-", "+", "#"],
  heatEmpty: " ",
  columnGap: "|",
  axisLine: "_",
  trendUp: "^",
  trendFlat: "-",
  rowCursor: ">",
  legendKey: "*",
  pointHollow: "+",
  pointFilled: "@",
  axisRule: "-",
  plotSpine: "|",
  trackMarker: "o",
  playhead: "v"
};
var SETS = {
  unicode: UNICODE_GLYPHS,
  nerd: UNICODE_GLYPHS,
  ascii: ASCII_GLYPHS
};
function glyphsFor(preset) {
  return SETS[preset];
}
function glyph(preset, role, level = 0) {
  const value = glyphsFor(preset)[role];
  if (typeof value === "string")
    return value;
  const clamped = Math.max(0, Math.min(value.length - 1, Math.round(level)));
  return value[clamped] ?? value[0];
}
var ALL_PRESETS = ["unicode", "nerd", "ascii"];
function glyphClass(...roles) {
  const glyphs = new Set;
  for (const preset of ALL_PRESETS) {
    for (const role of roles) {
      const value = glyphsFor(preset)[role];
      for (const g of typeof value === "string" ? [value] : value) {
        glyphs.add(g.replace(/[\\\]^-]/g, "\\$&"));
      }
    }
  }
  return [...glyphs].join("");
}
var ALL_GLYPH_CLASS = glyphClass(...Object.keys(UNICODE_GLYPHS));

// src/tui/charts/measure.ts
import { truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
function clampCells(text, width) {
  if (width <= 0)
    return "";
  return visibleWidth(text) > width ? truncateToWidth(text, width) : text;
}
var NO_ACTIVITY = "No activity recorded in this range.";

// src/tui/charts/host-adapter.ts
import { analyzeTable } from "@oh-my-pi/pi-tui/charts/table-data";
import { buildChart, planChart, worthCharting } from "@oh-my-pi/pi-tui/charts/chart-plan";

// src/tui/charts/compose.ts
function bandHeights(peaks, budget) {
  const count = peaks.length;
  if (count === 0 || budget <= 0)
    return peaks.map(() => 0);
  const loudest = peaks.map((peak, index) => ({ index, peak })).sort((a, b) => b.peak - a.peak || a.index - b.index);
  const rows = new Array(count).fill(1);
  let left = Math.max(0, budget - count);
  for (const { index, peak } of loudest) {
    if (left <= 0 || peak <= 0)
      continue;
    rows[index] = 2;
    left -= 1;
  }
  for (let spare = left;spare > 0; spare--) {
    let best = -1;
    let furthest = Number.POSITIVE_INFINITY;
    for (let index = 0;index < count; index++) {
      if (peaks[index] <= 0)
        continue;
      const below = rows[index] / peaks[index];
      if (below >= furthest)
        continue;
      furthest = below;
      best = index;
    }
    if (best < 0)
      break;
    rows[best] = (rows[best] ?? 0) + 1;
  }
  return rows;
}
function bandMax(series) {
  return series.reduce((shared, entry) => entry.values.reduce((peak, value) => value !== null && value > peak ? value : peak, shared), 0);
}

// node_modules/@oh-my-pi/omp-stats/src/client/data/series.ts
function densify(points, buckets, value) {
  const index = bucketIndex(buckets);
  const out = Array.from({ length: buckets.length }, () => 0);
  for (const point of points) {
    const i = index.get(point.timestamp);
    if (i !== undefined)
      out[i] += value(point);
  }
  return out;
}
function pivotSeries(points, opts) {
  const index = bucketIndex(opts.buckets);
  const byKey = new Map;
  for (const point of points) {
    const i = index.get(point.timestamp);
    if (i === undefined)
      continue;
    const key = opts.key(point);
    let values = byKey.get(key);
    if (!values) {
      values = Array.from({ length: opts.buckets.length }, () => 0);
      byKey.set(key, values);
    }
    values[i] += opts.value(point);
  }
  const ranked = [...byKey.entries()].map(([key, values]) => ({ key, values, total: values.reduce((sum, v) => sum + v, 0) })).filter((entry) => entry.total !== 0).sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));
  const limit = opts.limit ?? Number.POSITIVE_INFINITY;
  const head = ranked.slice(0, limit);
  const tail = ranked.slice(limit);
  const series = head.map((entry, rank) => ({
    key: entry.key,
    label: opts.label ? opts.label(entry.key) : entry.key,
    color: opts.colors?.get(entry.key) ?? SERIES_COLORS[rank % SERIES_COLORS.length],
    values: entry.values
  }));
  if (tail.length > 0) {
    const other = Array.from({ length: opts.buckets.length }, () => 0);
    for (const entry of tail)
      for (let i = 0;i < other.length; i++)
        other[i] += entry.values[i];
    series.push({ key: "__other__", label: `Other (${tail.length})`, color: OTHER_COLOR, values: other });
  }
  return series;
}
function bucketIndex(buckets) {
  const index = new Map;
  for (let i = 0;i < buckets.length; i++)
    index.set(buckets[i], i);
  return index;
}

// src/tui/charts/bars.ts
function mark(glyphs, role) {
  const value = glyphs[role];
  return typeof value === "string" ? value : value[0] ?? "";
}
function partialGlyph(glyphs, remainder) {
  const ramp = glyphs.sparkRamp;
  if (typeof ramp === "string")
    return ramp;
  const level = Math.max(0, Math.min(ramp.length - 1, Math.round(remainder * (ramp.length - 1))));
  return ramp[level] ?? ramp[0] ?? "";
}
function columnMagnitudes(values, rows, supplied) {
  if (rows <= 0)
    return values.map(() => ({ height: 0, fullRows: 0, remainder: 0 }));
  const max = supplied ?? Math.max(0, ...values.filter((v) => v !== null));
  if (max <= 0)
    return values.map(() => ({ height: 0, fullRows: 0, remainder: 0 }));
  return values.map((v) => {
    if (v === null || v <= 0)
      return { height: 0, fullRows: 0, remainder: 0 };
    const exact = v / max * rows;
    const capped = Math.min(rows, exact);
    const fullRows = Math.floor(capped);
    return {
      height: Math.max(1, Math.min(rows, Math.round(exact))),
      fullRows,
      remainder: capped - fullRows
    };
  });
}
function plotRows(height) {
  return Math.max(0, height - 1);
}
function compose(columns, rows, opts) {
  const fill = mark(opts.glyphs, "barFill");
  const ramp = opts.glyphs.sparkRamp;
  const density = opts.densityTop === true && typeof ramp !== "string" && ramp === glyphsFor("unicode").sparkRamp;
  const out = [];
  for (let r = 0;r < rows; r++) {
    const threshold = rows - r;
    const level = rows - 1 - r;
    out.push(columns.map((col) => {
      if (!density)
        return col.height >= threshold ? opts.accent(fill) : " ";
      if (level < col.fullRows)
        return opts.accent(fill);
      if (level === col.fullRows && col.remainder > 0) {
        return opts.accent(partialGlyph(opts.glyphs, col.remainder));
      }
      return " ";
    }).join(""));
  }
  const width = Math.max(0, Math.floor(opts.width));
  out.push(opts.dim(mark(opts.glyphs, "axisLine").repeat(width)));
  return out;
}
function renderDailyBars(values, opts) {
  if (values.length === 0) {
    return [opts.dim(clampCells(NO_ACTIVITY, Math.max(0, Math.floor(opts.width))))];
  }
  const width = Math.max(0, Math.floor(opts.width));
  const kept = width > 0 && values.length > width ? values.slice(values.length - width) : values;
  const columns = [
    ...kept,
    ...new Array(Math.max(0, width - kept.length)).fill(null)
  ];
  const rows = plotRows(opts.height);
  if (opts.reportBuckets) {
    const base = values.length - kept.length;
    const spans = [];
    for (let c = 0;c < kept.length; c++) {
      if (kept[c] === null)
        continue;
      spans.push({ rowStart: 0, rowEnd: rows + 1, colStart: c, colEnd: c + 1, index: base + c });
    }
    opts.reportBuckets(spans);
  }
  return compose(columnMagnitudes(columns, rows, opts.max), rows, { ...opts, width });
}

// src/tui/charts/host-adapter.ts
import { truncateToWidth as truncateToWidth2 } from "@oh-my-pi/pi-tui";
function cell(value, currency) {
  if (value === null || value === undefined || !Number.isFinite(value))
    return "\u2014";
  if (!currency)
    return String(value);
  return value < 0 ? `-$${-value}` : `$${value}`;
}
var ISO_CACHE_LIMIT = 8;
var isoColumnCache = new Map;
function isoColumn(axis) {
  const key = `${axis.length}:${axis[0]}:${axis[axis.length - 1]}`;
  const hit = isoColumnCache.get(key);
  if (hit !== undefined)
    return hit;
  const column = axis.map((timestamp) => new Date(timestamp).toISOString());
  if (isoColumnCache.size >= ISO_CACHE_LIMIT)
    isoColumnCache.delete(isoColumnCache.keys().next().value);
  isoColumnCache.set(key, column);
  return column;
}
function planTimeline(axis, rows, options) {
  if (!axis.length || !rows.length)
    return;
  const currency = rows.map((row) => options.currency ?? row.key === "cost");
  const bucket = isoColumn(axis);
  const table = analyzeTable(["Bucket", ...rows.map((row) => row.label)], bucket.map((when, index) => [
    when,
    ...rows.map((row, column) => cell(row.values[index], currency[column]))
  ]));
  const plan = planChart(table);
  if (!plan)
    return;
  const built = buildChart(table, plan);
  if (!built || !worthCharting(built))
    return;
  const spec = bypassLineCap(table, plan, built);
  let from = 0;
  const rowIndexes = spec.series.map((entry) => {
    const found = rows.findIndex((row, index) => index >= from && row.label === entry.name);
    const at = found >= 0 ? found : Math.min(from, rows.length - 1);
    from = found >= 0 ? found + 1 : at + 1;
    return at;
  });
  return { ...spec, stacked: options.stacked, cumulative: options.cumulative, rowIndexes };
}
function bypassLineCap(table, plan, spec) {
  const measures = table.measures.map((column) => column.index);
  const covered = new Set(plan.series);
  if (measures.every((index) => covered.has(index)))
    return spec;
  const rebuilt = buildChart(table, { ...plan, series: measures });
  return rebuilt && worthCharting(rebuilt) ? rebuilt : spec;
}
function renderSeriesChart(series, opts) {
  if (series.length === 0)
    return [];
  const glyphs = glyphsFor(opts.preset);
  const width = Math.max(0, Math.floor(opts.width));
  const dim = opts.dim ?? ((text) => text);
  if (series.every((entry) => entry.values.every((value) => value === null || value <= 0))) {
    return [dim(truncateToWidth2(NO_ACTIVITY, width))];
  }
  const colors = resolveSeries(series.length, opts.theme);
  const perBand = series.map((entry) => entry.values.reduce((max, value) => value !== null && value > max ? value : max, 0));
  const wanted = opts.labels !== false;
  const labelled = wanted && opts.height >= series.length * 2 + 1;
  const markable = Math.min(opts.height, labelled ? opts.height - series.length : opts.height);
  const rowsEach = bandHeights(perBand, markable);
  const max = bandMax(series);
  const heights = [...rowsEach];
  let spill = Math.max(0, heights.reduce((sum, rows) => sum + rows, 0) + (labelled ? series.length : 0) - opts.height);
  if (spill > 0) {
    const quietestFirst = series.map((_entry, index) => ({ index, peak: perBand[index] ?? 0 })).sort((a, b) => a.peak - b.peak || a.index - b.index);
    for (const { index } of quietestFirst) {
      while (spill > 0 && (heights[index] ?? 0) > 1) {
        heights[index] = (heights[index] ?? 0) - 1;
        spill -= 1;
      }
    }
    for (const { index } of quietestFirst) {
      while (spill > 0 && (heights[index] ?? 0) > 0) {
        heights[index] = 0;
        spill -= 1;
      }
    }
  }
  const rows = [];
  const report = opts.reportBuckets;
  for (const [index, entry] of series.entries()) {
    const color = opts.seriesColors?.[index] ?? colors[index] ?? colors[0];
    const apply = (text) => opts.paint(color, text);
    const height = heights[index] ?? 0;
    if (height > 0) {
      rows.push(...renderDailyBars(entry.values, {
        width,
        height,
        max,
        glyphs,
        accent: apply,
        dim,
        densityTop: opts.densityTop,
        reportBuckets: report ? (spans) => report(spans.map((span) => ({ ...span, rowStart: span.rowStart + rows.length, rowEnd: span.rowEnd + rows.length }))) : undefined
      }));
    }
    if (labelled) {
      const label = ` ${entry.label}`;
      rows.push(apply(truncateToWidth2(label, width).padEnd(width)));
    }
  }
  return rows;
}
function renderSharedAxisPlot(series, opts, stacked, cumulative) {
  const width = Math.max(1, Math.floor(opts.width));
  const height = Math.max(1, Math.floor(opts.height ?? 6));
  const dim = opts.dim ?? ((text) => text);
  const count = series[0].values.length;
  if (count === 0)
    return [dim(truncateToWidth2(NO_ACTIVITY, width))];
  let max = 0;
  for (let i = 0;i < count; i++) {
    let total = 0;
    for (const entry of series) {
      const value = entry.values[i];
      if (value === null)
        continue;
      if (value > max)
        max = value;
      total += value;
    }
    if (stacked && total > max)
      max = total;
  }
  if (!(max > 0))
    return [dim(truncateToWidth2(NO_ACTIVITY, width))];
  const colors = resolveSeries(series.length, opts.theme);
  const colorAt = (index) => opts.seriesColors?.[index] ?? colors[index] ?? colors[0];
  const spineWidth = width >= 2 ? 1 : 0;
  const available = Math.max(1, width - spineWidth);
  const slots = Math.min(count, available);
  const cellWidth = Math.max(1, Math.floor(available / slots));
  const plotWidth = slots * cellWidth;
  const start = count - slots;
  if (opts.reportBuckets) {
    const spans = [];
    for (let slot = 0;slot < slots; slot++) {
      const i = start + slot;
      if (!series.some((entry) => entry.values[i] !== null))
        continue;
      spans.push({ rowStart: 0, rowEnd: height, colStart: spineWidth + slot * cellWidth, colEnd: spineWidth + (slot + 1) * cellWidth, index: i });
    }
    opts.reportBuckets(spans);
  }
  const grid = Array.from({ length: height }, () => Array(plotWidth).fill(" "));
  for (let slot = 0;slot < slots; slot++) {
    const i = start + slot;
    if (stacked) {
      for (let y = 0;y < height; y++) {
        const low = (height - 1 - y) / height * max;
        const high = (height - y) / height * max;
        let base = 0;
        let coverage = 0;
        let dominant = 0;
        let color = colorAt(0);
        for (let r = 0;r < series.length; r++) {
          const value = series[r].values[i];
          if (value === null)
            continue;
          const overlap = Math.max(0, Math.min(base + value, high) - Math.max(base, low));
          coverage += overlap;
          if (overlap > dominant) {
            dominant = overlap;
            color = colorAt(r);
          }
          base += value;
        }
        if (coverage <= 0)
          continue;
        const level = Math.max(0, Math.min(SPARK_LEVELS - 1, Math.ceil(coverage / (high - low) * SPARK_LEVELS) - 1));
        const mark = opts.paint(color, glyph(opts.preset, "sparkRamp", level));
        for (let x = slot * cellWidth;x < (slot + 1) * cellWidth; x++)
          grid[y][x] = mark;
      }
    } else {
      for (let r = 0;r < series.length; r++) {
        const value = series[r].values[i];
        if (value === null)
          continue;
        const y = height - 1 - Math.max(0, Math.min(height - 1, Math.round(value / max * (height - 1))));
        const mark = opts.paint(colorAt(r), glyph(opts.preset, cumulative ? "pointFilled" : "pointHollow"));
        if (cumulative)
          for (let x = slot * cellWidth;x < (slot + 1) * cellWidth; x++)
            grid[y][x] = mark;
        else
          grid[y][slot * cellWidth + Math.floor((cellWidth - 1) / 2)] = mark;
      }
    }
  }
  const spine = spineWidth > 0 ? dim(glyph(opts.preset, "plotSpine")) : "";
  return grid.map((row) => spine + row.join(""));
}
function renderHostChart(spec, opts) {
  const { width, preset, theme, paint, dim, labels } = opts;
  if (!spec.series.length)
    return [];
  const series = spec.series.map((entry) => ({
    label: entry.name,
    values: entry.points.map((point) => point === null || point === undefined ? null : point.value)
  }));
  const temporal = spec.kind === "line";
  const stacked = spec.stacked === true;
  const cumulative = spec.cumulative === true;
  const lines = temporal && (series.length > 1 || stacked || cumulative) ? renderSharedAxisPlot(series, opts, stacked, cumulative) : renderSeriesChart(series, {
    width,
    height: opts.height ?? 6,
    preset,
    theme,
    paint,
    dim: dim ?? ((text) => text),
    labels,
    seriesColors: opts.seriesColors,
    densityTop: preset !== "ascii"
  });
  return lines;
}

// src/tui/charts/time-series.ts
function emptyState(active, filter) {
  let measured = false;
  let max = 0;
  for (const row of active)
    for (const value of row.values) {
      if (value === null || value === undefined)
        continue;
      measured = true;
      if (value > max)
        max = value;
    }
  const base = !measured ? "No readings in the visible series; gaps are not zero." : max === 0 ? "No positive measured values in this range." : "No chart-worthy data in this range.";
  return filter ? `${base} Matching ${filter}.` : base;
}
function formatBucket(dateMs) {
  return new Date(dateMs).toISOString().slice(5, 16).replace("T", " ");
}
function renderTimeSeries(ctx, axis, rows, width, selected, options = {}) {
  const w = Math.max(1, Math.floor(width));
  if (!axis.length || !rows.length)
    return wrapTextWithAnsi(ctx.theme.fg("dim", "No recorded chart observations in this range."), w);
  const preset = ctx.theme.getSymbolPreset();
  const format = options.format ?? (options.percent ? (value) => formatPercent2(value, 0) : compactTokens);
  const active = rows.filter((row) => !options.hidden?.has(row.key));
  const colors = resolveSeries(Math.max(rows.length, ...rows.map((row) => (row.colorIndex ?? 0) + 1)), ctx.theme);
  const seriesColors = rows.map((row, r) => ({ row, color: colors[row.colorIndex ?? r] })).filter(({ row }) => !options.hidden?.has(row.key)).map(({ color }) => color);
  selected = Math.max(0, Math.min(axis.length - 1, selected));
  const date = formatBucket(axis[selected]);
  const lines = wrapTextWithAnsi(ctx.theme.fg("dim", `${options.unit ? options.unit + " \xB7 " : ""}${date} UTC \xB7 ${axis.length} buckets`), w);
  if (!active.length)
    lines.push(...wrapTextWithAnsi(ctx.theme.fg("dim", "All series hidden; select a legend and toggle visibility to restore it."), w));
  else {
    const plotStart = lines.length;
    const spec = planTimeline(axis, active, options);
    if (!spec)
      lines.push(...wrapTextWithAnsi(ctx.theme.fg("dim", emptyState(active, options.filter)), w));
    else
      lines.push(...renderHostChart(spec, {
        width: w,
        height: options.height,
        preset,
        theme: ctx.theme,
        paint: (color, text) => ctx.theme.fg(color, text),
        seriesColors: spec.series.map((_entry, index) => {
          const row = spec.rowIndexes?.[index] ?? index;
          return seriesColors[row] ?? seriesColors[0];
        }),
        dim: (text) => ctx.theme.fg("dim", text),
        labels: false,
        reportBuckets: options.reportBuckets ? (spans) => options.reportBuckets(spans.map((span) => ({ ...span, rowStart: span.rowStart + plotStart, rowEnd: span.rowEnd + plotStart }))) : undefined
      }));
  }
  const first = formatBucket(axis[0]);
  const last = formatBucket(axis[axis.length - 1]);
  lines.push(...wrapTextWithAnsi(ctx.theme.fg("dim", `${first} \u2192 ${last} UTC`), w));
  if (options.legend !== false)
    for (let r = 0;r < rows.length; r++) {
      const row = rows[r], hidden = options.hidden?.has(row.key);
      const value = row.values[selected];
      const detail = (options.formatValue?.(row.key, value, selected) ?? (value === null || value === undefined ? "\u2014" : format(value))) + (row.legendValue === undefined ? "" : ` \xB7 ${row.legendValue}`);
      const prefix = `${row.key === options.selectedKey ? glyph(preset, "rowCursor") : " "} ${ctx.theme.fg(hidden ? "dim" : colors[row.colorIndex ?? r], glyph(preset, "legendKey"))} `;
      const label = clampCells((hidden ? "off " : "") + row.label, Math.max(1, w - visibleWidth2(prefix) - visibleWidth2(detail) - 2));
      const line = prefix + label + " ".repeat(Math.max(1, w - visibleWidth2(prefix + label) - visibleWidth2(detail))) + detail;
      lines.push(hidden ? ctx.theme.fg("dim", line) : line);
    }
  return lines.map((line) => clampCells(line, w));
}

// src/tui/features/presentation.ts
import { truncateToWidth as truncateToWidth6, visibleWidth as visibleWidth5, wrapTextWithAnsi as wrapTextWithAnsi2 } from "@oh-my-pi/pi-tui";

// src/tui/band.ts
import { truncateToWidth as truncateToWidth4, visibleWidth as visibleWidth3 } from "@oh-my-pi/pi-tui";

// src/tui/icons.ts
var HOST_ICON_KEYS = {
  cost: "icon.cost",
  tokens: "icon.tokens",
  requests: "cmd.stats",
  time: "icon.time",
  models: "icon.model",
  providers: "icon.host",
  tools: "icon.extensionTool",
  projects: "icon.folder",
  errors: "status.error",
  unknown: "cmd.question",
  cache: "icon.cache",
  warning: "icon.warning"
};
var STATS_ICONS = {
  unicode: {
    cost: "\uD83D\uDCB2",
    tokens: "\uD83E\uDE99",
    requests: "\uD83D\uDCCA",
    time: "\u23F1",
    models: "\u2B22",
    providers: "\uD83D\uDEF0",
    tools: "\uD83D\uDEE0",
    projects: "\uD83D\uDCC1",
    errors: "\u274C",
    calendar: "\uD83D\uDCC5",
    gains: "\uD83D\uDCB9",
    trendUp: "\u2197",
    trendDown: "\u2198",
    unknown: "\u2753",
    cache: "\uD83D\uDCBE",
    warning: "\u26A0"
  },
  nerd: {
    cost: "\uF155",
    tokens: "\uE26B",
    requests: "\uF201",
    time: "\uF017",
    models: "\uEC19",
    providers: "\uDB81\uDC8B",
    tools: "\uF0AD",
    projects: "\uF07C",
    errors: "\uF057",
    calendar: "\uF073",
    gains: "\uDB81\uDD35",
    trendUp: "\uF062",
    trendDown: "\uF063",
    unknown: "\uF059",
    cache: "\uF1C0",
    warning: "\uF071"
  },
  ascii: {
    cost: "$",
    tokens: "tok:",
    requests: "req:",
    time: "t:",
    models: "[M]",
    providers: "host",
    tools: "TL",
    projects: "[D]",
    errors: "[!!]",
    calendar: "cal",
    gains: "+",
    trendUp: "+",
    trendDown: "-",
    unknown: "?",
    cache: "cache",
    warning: "[!]"
  }
};
function statsIcon(preset, role, theme) {
  const key = HOST_ICON_KEYS[role];
  if (key && theme)
    return theme.symbol(key);
  return STATS_ICONS[preset][role];
}

// src/tui/band.ts
var TILE_MAX_COLUMNS = 3;
var TILE_GUTTER = 2;
var TILE_MAX_WIDTH = 34;
var BAND_ICONS = { table: "requests" };
function tileWidthOf(stats) {
  let widest = 1;
  for (const tile of stats) {
    widest = Math.max(widest, visibleWidth3(tile.label), visibleWidth3(tile.value), tile.hint === undefined ? 0 : visibleWidth3(tile.hint));
  }
  return Math.min(widest, TILE_MAX_WIDTH);
}
function tileColumns(inner, tileWidth) {
  return Math.max(1, Math.min(TILE_MAX_COLUMNS, Math.floor((inner + TILE_GUTTER) / (tileWidth + TILE_GUTTER))));
}
function clamp(text, width) {
  if (width <= 0)
    return "";
  return visibleWidth3(text) > width ? truncateToWidth4(text, width) : text;
}
function padEndTo(text, width) {
  const gap = width - visibleWidth3(text);
  return gap > 0 ? text + " ".repeat(gap) : text;
}
function padStartTo(text, width) {
  const gap = width - visibleWidth3(text);
  return gap > 0 ? " ".repeat(gap) + text : text;
}
function renderStatRow(stats, ctx) {
  if (stats.length === 0)
    return [];
  const inner = Math.max(1, ctx.innerWidth);
  const tileWidth = tileWidthOf(stats);
  const columns = tileColumns(inner, tileWidth);
  const cell = Math.max(1, Math.min(tileWidth, Math.floor((inner - (columns - 1) * TILE_GUTTER) / columns)));
  const sparkWidth = Math.max(0, cell - 1);
  const sparkVisible = columns <= 2;
  const lines = [];
  for (let start = 0;start < stats.length; start += columns) {
    const tiles = stats.slice(start, start + columns);
    const slots = [[], [], [], []];
    const populated = [true, true, false, false];
    for (const tile of tiles) {
      slots[0].push(padEndTo(clamp(ctx.bold(ctx.fg(PALETTE.muted, tile.label)), cell), cell));
      const value = tile.emphasis === "primary" ? ctx.bold(ctx.fg(PALETTE.primary, tile.value)) : ctx.fg(PALETTE.label, tile.value);
      slots[1].push(padEndTo(clamp(value, cell), cell));
      const hint = tile.hint ?? "";
      slots[2].push(padEndTo(visibleWidth3(hint) <= cell ? ctx.fg(PALETTE.dim, hint) : "", cell));
      if (hint !== "")
        populated[2] = true;
      slots[3].push(padEndTo(tile.spark && sparkVisible && sparkWidth > 0 ? (ctx.sparkline ?? (() => ""))(tile.spark, sparkWidth) : "", cell));
      if (tile.spark && sparkVisible && sparkWidth > 0)
        populated[3] = true;
    }
    const lastPopulated = populated.reduce((last, has, index) => has ? index : last, 1);
    const rows = slots.slice(0, lastPopulated + 1).map((cells) => clamp(cells.join(" ".repeat(TILE_GUTTER)), Math.min(ctx.width, inner)).trimEnd());
    let end = rows.length;
    while (end > 0 && rows[end - 1].trim() === "")
      end--;
    lines.push(...rows.slice(0, end));
  }
  return lines;
}
function columnWidths(columns, rows) {
  return columns.map((column) => {
    let widest = visibleWidth3(column.header);
    for (const row of rows) {
      const value = row[column.key];
      if (value !== undefined)
        widest = Math.max(widest, visibleWidth3(value));
    }
    return widest;
  });
}
function fitColumns(columns, widths, available) {
  const gutter = 1;
  let kept = columns.map((_, index) => index);
  const cost = (indices) => indices.reduce((sum, index) => sum + (widths[index] ?? 0), 0) + gutter * Math.max(0, indices.length - 1);
  while (cost(kept) > available && kept.length > 1) {
    const candidates = kept.filter((index) => index > 0);
    const victim = candidates.reduce((worst, index) => (columns[index]?.priority ?? 0) >= (columns[worst]?.priority ?? 0) ? index : worst);
    kept = kept.filter((index) => index !== victim);
  }
  const surplus = cost(kept) - available;
  return kept.map((index, position) => ({
    column: columns[index],
    width: position === 0 && surplus > 0 ? Math.max(1, (widths[index] ?? 1) - surplus) : widths[index] ?? 1
  }));
}
function renderTable(band, ctx) {
  const all = band.rows.rows;
  if (band.columns.length === 0 || all.length === 0)
    return [];
  const available = Math.max(1, Math.min(ctx.width, ctx.innerWidth));
  const measured = columnWidths(band.columns, all);
  if (ctx.identityWidth !== undefined)
    measured[0] = Math.min(measured[0] ?? 0, ctx.identityWidth);
  if (band.selectedRow !== undefined)
    measured[0] = (measured[0] ?? 0) + 2;
  const kept = fitColumns(band.columns, measured, available);
  const line = (cells, style) => cells.map((cell, index) => {
    const width = kept[index]?.width ?? 0;
    const text = style(clamp(cell ?? "", width));
    return kept[index]?.column.align === "left" ? padEndTo(text, width) : padStartTo(text, width);
  }).join(" ");
  const header = line(kept.map((c, index) => (index === 0 && band.selectedRow !== undefined ? "  " : "") + c.column.header), (t) => ctx.fg(PALETTE.dim, t)).trimEnd();
  const cursor = band.selectedRow === undefined ? "" : glyph(ctx.preset, "rowCursor");
  const body = all.map((r, rowIndex) => {
    const selected = rowIndex === band.selectedRow;
    const rendered = line(kept.map((c, index) => (index === 0 && band.selectedRow !== undefined ? `${selected ? cursor : " "} ` : "") + String(r[c.column.key] ?? "")), (t) => ctx.fg(selected ? PALETTE.primary : PALETTE.label, t)).trimEnd();
    return selected && ctx.selected ? ctx.selected(rendered) : rendered;
  });
  return [
    ...band.title ? [heading(BAND_ICONS.table, band.title, band.source ?? "", ctx.preset, ctx)] : [],
    header,
    ...body
  ];
}
function heading(icon, title, meta, preset, ctx) {
  const parts = [statsIcon(preset, icon), ctx.bold(ctx.fg(PALETTE.heading, title))];
  if (meta !== "")
    parts.push(ctx.fg(PALETTE.meta, meta));
  return clamp(parts.join(" "), ctx.width);
}
function renderBands(bands, ctx) {
  const lines = [];
  for (const band of bands) {
    const body = band.kind === "statRow" ? renderStatRow(band.stats, ctx) : renderTable(band, ctx);
    if (body.length === 0)
      continue;
    if (lines.length > 0)
      lines.push("");
    lines.push(...body);
  }
  return lines;
}

// src/tui/charts/sparkline.ts
import { visibleWidth as visibleWidth4, truncateToWidth as truncateToWidth5 } from "@oh-my-pi/pi-tui";
function renderSparkline(values, opts) {
  const width = Math.max(0, Math.floor(opts.width));
  if (width === 0)
    return "";
  const start = Math.max(0, values.length - width);
  const padding = Math.max(0, width - values.length);
  let max = opts.max ?? 0;
  if (opts.max === undefined) {
    for (const value of values)
      if (typeof value === "number" && Number.isFinite(value) && value > max)
        max = value;
  }
  const scale = Number.isFinite(max) && max > 0;
  const ramp = glyphsFor(opts.preset ?? "unicode").sparkRamp;
  let result = " ".repeat(padding);
  for (let index = start;index < values.length; index++) {
    const value = values[index];
    if (value === null || !Number.isFinite(value)) {
      result += " ";
      continue;
    }
    const level = scale ? Math.max(0, Math.min(7, Math.round(Math.max(0, value) / max * 7))) : 0;
    const cell = typeof ramp === "string" ? ramp : ramp[level];
    result += opts.accent ? opts.accent(cell, level) : cell;
  }
  return result;
}

// src/tui/features/presentation.ts
function options(ctx, width) {
  const preset = ctx.theme.getSymbolPreset();
  return {
    width,
    innerWidth: width,
    preset,
    glyphs: glyphsFor(preset),
    fg: (color, text) => ctx.theme.fg(color, text),
    bold: (text) => ctx.theme.bold(text),
    barHeight: 4,
    labelWidth: 14,
    valueWidth: 12,
    identityWidth: Math.max(8, Math.floor(width * 0.42)),
    sparkline: (values, columns) => renderSparkline(values, { width: columns, preset, accent: (cell) => ctx.theme.fg(PALETTE.primary, cell) }),
    selected: (text) => ctx.theme.bg(SELECTION_BG.band, text + " ".repeat(Math.max(0, width - visibleWidth5(text))))
  };
}
var RAIL_GAP = 2;
var SIDE_GAP = 2;
var CAVEAT = /unpriced|no price|not priced/i;
function caveatParts(tile) {
  const parts = [];
  if (CAVEAT.test(tile.label))
    parts.push(tile.label);
  if (CAVEAT.test(tile.value))
    parts.push(tile.value);
  if (tile.hint && CAVEAT.test(tile.hint))
    parts.push(`(${tile.hint})`);
  return parts.join(" ");
}
function buildRailTile(ctx, tile) {
  const label = ctx.theme.fg(PALETTE.muted, tile.label);
  const value = tile.emphasis === "primary" ? ctx.theme.bold(ctx.theme.fg(PALETTE.primary, tile.value)) : ctx.theme.fg(PALETTE.label, tile.value);
  const hint = tile.hint ? ctx.theme.fg(PALETTE.dim, ` (${tile.hint})`) : "";
  const caveat = caveatParts(tile);
  const caveatLabel = CAVEAT.test(tile.label) ? ctx.theme.fg(PALETTE.muted, tile.label) : "";
  const caveatValue = CAVEAT.test(tile.value) ? ctx.theme.fg(PALETTE.label, tile.value) : "";
  const caveatHint = tile.hint && CAVEAT.test(tile.hint) ? ctx.theme.fg(PALETTE.dim, `(${tile.hint})`) : "";
  return {
    full: `${label} ${value}${hint}`,
    plain: `${label} ${value}`,
    minimal: [caveatLabel, caveatValue, caveatHint].filter(Boolean).join(" "),
    caveat: caveat !== ""
  };
}
function fitRailCell(text, width, minimal) {
  const cell = Math.max(0, width);
  if (cell === 0)
    return "";
  let candidate = text;
  if (visibleWidth5(candidate) > cell && minimal !== "" && visibleWidth5(minimal) <= cell)
    candidate = minimal;
  if (visibleWidth5(candidate) > cell)
    candidate = truncateToWidth6(candidate, cell, "");
  const padding = cell - visibleWidth5(candidate);
  return padding > 0 ? candidate + " ".repeat(padding) : candidate;
}
function railRow(built, available) {
  const count = built.length;
  if (count === 0)
    return "";
  const gap = Math.min(RAIL_GAP, Math.max(0, Math.floor((available - count) / Math.max(1, count - 1))));
  const budget = Math.max(0, available - gap * (count - 1));
  const caveats = built.map((tile, index) => tile.caveat ? index : -1).filter((index) => index >= 0);
  let texts = built.map((tile) => tile.full);
  let widths = texts.map((text) => visibleWidth5(text));
  let used = widths.reduce((sum, width) => sum + width, 0);
  if (used > budget) {
    texts = built.map((tile, index) => tile.caveat ? texts[index] : tile.plain);
    widths = texts.map((text) => visibleWidth5(text));
    used = widths.reduce((sum, width) => sum + width, 0);
  }
  const caveatWidth = () => caveats.reduce((sum, index) => sum + visibleWidth5(texts[index]), 0);
  if (used > budget && caveatWidth() > Math.max(0, budget - (count - caveats.length))) {
    for (const index of caveats)
      texts[index] = built[index].minimal || texts[index];
    widths = texts.map((text) => visibleWidth5(text));
    used = widths.reduce((sum, width) => sum + width, 0);
  }
  if (used > budget) {
    const others = built.map((_, index) => index).filter((index) => !built[index].caveat);
    const share = Math.max(others.length, budget - caveatWidth());
    const natural = others.reduce((sum, index) => sum + visibleWidth5(texts[index]), 0) || 1;
    for (const index of others) {
      widths[index] = Math.max(1, Math.floor(share * visibleWidth5(texts[index]) / natural));
    }
    let total = widths.reduce((sum, width) => sum + width, 0);
    for (let index = 0;total < budget && others.length > 0; index = (index + 1) % others.length) {
      widths[others[index]]++;
      total++;
    }
    while (total > budget) {
      const shrink = others.find((index) => widths[index] > 1);
      if (shrink === undefined)
        break;
      widths[shrink]--;
      total--;
    }
  }
  return built.map((tile, index) => fitRailCell(texts[index], widths[index], tile.minimal)).join(" ".repeat(gap));
}
function railMarker(ctx, dropped, width) {
  if (dropped.length === 0)
    return "";
  let marker = ` +${dropped.length}`;
  for (const tile of dropped) {
    let excerpt = "";
    for (const text of [tile.label, tile.value, tile.hint ?? ""]) {
      if (!CAVEAT.test(text))
        continue;
      excerpt = text.match(/\d[\d,]*\s+unpriced|no price[^,;]*|not priced|unpriced/i)?.[0]?.trim() ?? text;
      break;
    }
    if (excerpt === "")
      continue;
    const candidate = `${marker} \xB7 ${excerpt}`;
    if (visibleWidth5(candidate) <= width)
      marker = candidate;
    else
      break;
  }
  if (visibleWidth5(marker) > width)
    marker = truncateToWidth6(marker, width, "");
  return ctx.theme.fg(PALETTE.dim, marker);
}
function sideCell(line, width) {
  const text = line ?? "";
  const fitted = visibleWidth5(text) > width ? truncateToWidth6(text, width, "") : text;
  const padding = width - visibleWidth5(fitted);
  return padding > 0 ? fitted + " ".repeat(padding) : fitted;
}
function metricGrid(ctx, width, tiles) {
  return [...renderBands([{ kind: "statRow", stats: tiles }], options(ctx, width))];
}
function metricRail(ctx, width, tiles, options = {}) {
  if (tiles.length === 0)
    return [];
  const columns = width >= 80 ? 3 : 2;
  const requested = options.maxRows ?? 2;
  const rows = Number.isFinite(requested) ? Math.max(1, Math.min(2, Math.floor(requested))) : 2;
  const visible = tiles.slice(0, columns * rows);
  const marker = railMarker(ctx, tiles.slice(columns * rows), width);
  const built = visible.map((tile) => buildRailTile(ctx, tile));
  const lines = [];
  for (let start = 0;start < built.length; start += columns) {
    const row = built.slice(start, start + columns);
    const last = start + columns >= built.length;
    const available = Math.max(0, width - (last ? visibleWidth5(marker) : 0));
    lines.push(railRow(row, available) + (last ? marker : ""));
  }
  return lines;
}
function dataTable(ctx, width, title, columns, rows, selectedRow) {
  return [...renderBands([{ kind: "table", title, columns, rows: { kind: "inline", rows }, selectedRow }], options(ctx, width))];
}
function sideBySide(ctx, width, left, right, options = {}) {
  if (width < 80) {
    const rows = left.map((line) => sideCell(line, width));
    if (rows.length > 0 && right.length > 0)
      rows.push("");
    for (const line of right)
      rows.push(sideCell(line, width));
    return rows;
  }
  const available = Math.max(SIDE_GAP + 2, width - SIDE_GAP);
  const requested = options.leftRatio ?? 0.5;
  const ratio = Number.isFinite(requested) ? Math.max(0, Math.min(1, requested)) : 0.5;
  const leftWidth = Math.max(1, Math.min(available - 1, Math.floor(available * ratio)));
  const rightWidth = available - leftWidth;
  const lines = [];
  for (let index = 0;index < Math.max(left.length, right.length); index++) {
    lines.push(sideCell(left[index], leftWidth) + " ".repeat(SIDE_GAP) + sideCell(right[index], rightWidth));
  }
  return lines;
}
function sectionHeading(ctx, width, title, meta = "", active = false) {
  return truncateToWidth6(ctx.theme.bold(ctx.theme.fg(active ? PALETTE.primary : PALETTE.muted, title)) + (meta ? ctx.theme.fg(PALETTE.dim, `  ${meta}`) : ""), Math.max(1, width));
}
function focusTabs(ctx, width, labels, selected) {
  const line = labels.map((label, index) => index === selected ? ctx.theme.bg(SELECTION_BG.band, ctx.theme.bold(ctx.theme.fg(PALETTE.primary, `> ${label} `))) : ctx.theme.fg(PALETTE.dim, ` ${label} `)).join("  ");
  return wrapTextWithAnsi2(line, Math.max(1, width));
}

// src/tui/features/core/shared.ts
function wrap(lines, width) {
  const w = Math.max(1, Math.floor(width));
  return lines.flatMap((line) => wrapTextWithAnsi3(line, w).map((part) => truncateToWidth7(part, w)));
}
function fields(value, prefix = "") {
  if (value === null || value === undefined)
    return [`${prefix || "Value"}: \u2014`];
  if (typeof value !== "object")
    return [`${prefix || "Value"}: ${String(value)}`];
  return Object.entries(value).flatMap(([key, item]) => fields(item, prefix ? `${prefix}.${key}` : key));
}
function panePrefix(active) {
  return active ? "> " : "  ";
}
function paneHeading(ctx, width, title, meta = "", active = false) {
  return sectionHeading(ctx, width, `${panePrefix(active)}${title}`, meta, active);
}

class ListState {
  key;
  initialLimit;
  search = "";
  editing = false;
  sort;
  descending = true;
  reveal;
  selected = null;
  lastHits = [];
  constructor(key, initialSort, initialLimit = 100) {
    this.key = key;
    this.initialLimit = initialLimit;
    this.sort = initialSort;
    this.reveal = initialLimit;
  }
  rows(rows, sorters) {
    const getter = sorters[this.sort];
    if (!getter)
      return [...rows];
    return [...rows].sort((a, b) => {
      const av = getter(a) ?? -Infinity, bv = getter(b) ?? -Infinity;
      const order = typeof av === "string" && typeof bv === "string" ? av.localeCompare(bv) : av < bv ? -1 : av > bv ? 1 : 0;
      return (this.descending ? -order : order) || this.key(a).localeCompare(this.key(b));
    });
  }
  current(rows) {
    const found = rows.find((row) => this.key(row) === this.selected);
    const chosen = found ?? rows[0];
    if (!found && chosen)
      this.selected = this.key(chosen);
    return chosen;
  }
  move(rows, delta) {
    if (!rows.length)
      return;
    const current = rows.findIndex((row) => this.key(row) === this.selected);
    const next = Math.max(0, Math.min(rows.length - 1, (current < 0 ? 0 : current) + delta));
    this.selected = this.key(rows[next]);
    this.reveal = Math.max(this.reveal, next + 1);
  }
  input(data, rows) {
    if (data === "\x0E" || data === "\x10" || data === "\x1B[C" || data === "\x1B[D" || data === "\x1B[5~" || data === "\x1B[6~" || data === "\x1B[H" || data === "\x1B[F" || data === "\x1B[1~" || data === "\x1B[4~")
      return false;
    if (this.editing) {
      if (data === "\x1B" || data === "\r" || data === `
`)
        this.editing = false;
      else if (data === "\x7F" || data === "\b")
        this.search = [...this.search].slice(0, -1).join("");
      else if (data === "\x15")
        this.search = "";
      else if (!/[\x00-\x1f\x7f]/.test(data))
        this.search += data;
      return true;
    }
    if (data === "q" || data === "[" || data === "]")
      return false;
    if (data === "/") {
      this.editing = true;
      return true;
    }
    if (data === "\x1B" && this.search) {
      this.search = "";
      return true;
    }
    if (data === "j" || data === "\x1B[B") {
      this.move(rows, 1);
      return true;
    }
    if (data === "k" || data === "\x1B[A") {
      this.move(rows, -1);
      return true;
    }
    if (data === "+") {
      this.reveal += this.initialLimit;
      return true;
    }
    if (data === "a") {
      this.reveal = Infinity;
      return true;
    }
    return false;
  }
  render(rows, width, height, columns, ctx, title, options = {}) {
    const search = this.editing ? [`Search: ${this.search || "\u2014"}  \xB7 Enter/Esc finish \xB7 Ctrl-U clear`] : this.search ? [`Search: ${this.search}`] : [];
    const searchLines = wrap(search, width);
    if (!rows.length) {
      this.lastHits = [];
      return [
        sectionHeading(ctx, width, title),
        ...searchLines,
        ...wrap([ctx.theme.fg("dim", this.search ? "No matches. Esc clears search." : "No visible records. Change range or filters.")], width)
      ];
    }
    const current = this.current(rows);
    const index = rows.indexOf(current);
    this.reveal = Math.max(this.reveal, index + 1);
    const count = Math.max(1, Math.min(Math.max(1, height - 3 - searchLines.length), this.reveal, rows.length));
    const start = Math.max(0, Math.min(index - Math.floor(count / 2), Math.min(rows.length, this.reveal) - count));
    const visible = rows.slice(start, start + count);
    const records = visible.map((row) => Object.fromEntries(columns.map((column) => [column.key, column.value(row)])));
    this.lastHits = visible.map((row, line) => ({
      rowStart: 2 + searchLines.length + line,
      rowEnd: 3 + searchLines.length + line,
      colStart: 0,
      colEnd: width,
      action: { type: "selectRow", key: this.key(row) }
    }));
    return [
      sectionHeading(ctx, width, title, `${start + 1}\u2013${start + count}/${rows.length} \xB7 ${this.sort} ${this.descending ? "\u2193" : "\u2191"}`),
      ...searchLines,
      ...dataTable(ctx, width, "", columns, records, index - start),
      ...options.showHint === false ? [] : wrap([ctx.theme.fg("dim", "/ search \xB7 j/k select \xB7 Enter inspect, o/O sort \xB7 +/a reveal")], width)
    ];
  }
}

class ChartState {
  mode = 0;
  seriesIndex = 0;
  point = -1;
  timestamp = null;
  selectedSeries = null;
  hidden = new Set;
  input(data, keys) {
    if (data === "n") {
      this.seriesIndex = (this.seriesIndex + 1) % Math.max(1, keys.length);
      this.selectedSeries = keys[this.seriesIndex] ?? null;
      return true;
    }
    if (data === "v") {
      const key = keys[this.seriesIndex % Math.max(1, keys.length)];
      if (key)
        this.hidden.has(key) ? this.hidden.delete(key) : this.hidden.add(key);
      return true;
    }
    if (data === ",") {
      this.point = Math.max(0, this.point - 1);
      this.timestamp = null;
      return true;
    }
    if (data === ".") {
      this.point++;
      this.timestamp = null;
      return true;
    }
    return false;
  }
  selectPoint(index, count) {
    if (count <= 0)
      return;
    this.point = Math.max(0, Math.min(count - 1, index));
    this.timestamp = null;
  }
  seedLatestPoint(buckets, timestamps) {
    if (this.point >= 0 || !buckets.length)
      return;
    let latest = -Infinity;
    for (const timestamp of timestamps)
      latest = Math.max(latest, timestamp);
    this.point = buckets.length - 1;
    for (let i = buckets.length - 1;i >= 0; i--) {
      if (buckets[i] <= latest) {
        this.point = i;
        break;
      }
    }
  }
  reconcile(buckets, keys) {
    const point = this.timestamp === null ? -1 : buckets.indexOf(this.timestamp);
    if (buckets.length) {
      this.point = point >= 0 ? point : Math.max(0, Math.min(this.point < 0 ? buckets.length - 1 : this.point, buckets.length - 1));
      if (this.timestamp === null)
        this.timestamp = buckets[this.point];
    }
    const series = this.selectedSeries === null ? -1 : keys.indexOf(this.selectedSeries);
    this.seriesIndex = series >= 0 ? series : this.seriesIndex % Math.max(1, keys.length);
    if (this.selectedSeries === null && keys.length)
      this.selectedSeries = keys[this.seriesIndex];
  }
  get selectedKey() {
    return this.selectedSeries;
  }
  render(ctx, width, buckets, series, options = {}) {
    this.reconcile(buckets, series.map((row) => row.key));
    const { showHint = true, ...chartOptions } = options;
    return [...renderTimeSeries(ctx, buckets, series, width, this.point, {
      ...chartOptions,
      hidden: this.hidden,
      selectedKey: series[this.seriesIndex]?.key
    }), ...showHint ? wrap([ctx.theme.fg("dim", "m mode \xB7 n legend \xB7 v visibility \xB7 ,/. point")], width) : []];
  }
}

// src/tui/features/core/requests.ts
class RequestDetails {
  ctx;
  active = false;
  disposed = false;
  generation = 0;
  row = null;
  payload = null;
  error = null;
  notice = null;
  section = 0;
  collapsed = new Set(["Session entry", "Stats row"]);
  constructor(ctx) {
    this.ctx = ctx;
  }
  async open(row) {
    if (this.disposed)
      return;
    const generation = ++this.generation;
    this.active = true;
    this.row = row;
    this.payload = null;
    this.error = null;
    this.notice = null;
    this.section = 0;
    this.collapsed.clear();
    this.collapsed.add("Session entry");
    this.collapsed.add("Stats row");
    this.ctx.changed();
    if (row.id === undefined) {
      this.error = "Request has no stored id; full payload unavailable.";
      this.ctx.changed();
      return;
    }
    try {
      const payload = await this.ctx.reader.api(`/api/request/${row.id}`);
      if (this.disposed || !this.active || generation !== this.generation)
        return;
      this.payload = payload;
    } catch (error) {
      if (this.disposed || !this.active || generation !== this.generation)
        return;
      this.error = String(error);
    }
    this.ctx.changed();
  }
  render(width) {
    if (!this.active)
      return null;
    const lines = [paneHeading(this.ctx, width, `Request #${this.row?.id ?? "\u2013"}`, "", true)];
    if (this.notice)
      lines.push(this.notice);
    if (!this.payload)
      return wrap([
        ...lines,
        this.error ? `Error: ${this.error}${this.row?.id === undefined ? "" : " \xB7 e retry"}` : "Loading request details\u2026",
        this.ctx.theme.fg("dim", "b/Esc back"),
        ...this.row ? ["Loaded request metadata (session payload unavailable)", ...fields(this.row)] : []
      ], width);
    const d = this.payload;
    const sections = this.sections(d);
    const selected = sections[this.section % sections.length];
    lines.push(paneHeading(this.ctx, width, `${d.model} \xB7 ${d.provider}`, requestStatus(d), true), ...d.errorMessage ? [this.ctx.theme.fg("error", `${requestStatus(d) === "aborted" ? "Aborted" : "Error"}: ${d.errorMessage}`)] : [], ...metricGrid(this.ctx, width, [
      { label: "API estimate", value: formatMessageCost(d, 4), emphasis: "primary", hint: `unpriced requests: ${Number(d.costUnpriced ?? false)}` },
      { label: "Duration", value: formatDurationMs(d.duration), hint: formatTimestamp(d.timestamp) },
      { label: "TTFT", value: formatDurationMs(d.ttft) },
      { label: "Throughput", value: `${formatTokensPerSecond(d.duration !== null && d.duration > 0 && d.usage.output > 0 ? d.usage.output * 1000 / d.duration : null)} tok/s` }
    ]), ...dataTable(this.ctx, width, "Tokens", [{ key: "bucket", header: "Bucket", align: "left" }, { key: "tokens", header: "Tokens", align: "right" }], Object.entries({ "Uncached input": d.usage.input, "Cache read": d.usage.cacheRead, "Cache write": d.usage.cacheWrite, Output: d.usage.output, Total: d.usage.totalTokens, "Premium requests": d.usage.premiumRequests ?? 0 }).map(([bucket, value]) => ({ bucket, tokens: Number.isInteger(value) ? formatInteger(value) : String(value) }))), paneHeading(this.ctx, width, "Billing components", "", false), ...Object.entries(d.usage.cost).map(([component, value]) => `${component}: ${d.costUnpriced ? "unpriced request; component estimate unavailable" : formatCost(value)}`), paneHeading(this.ctx, width, "Identity", "", false), ...fields({ requestId: d.id, entryId: d.entryId, stopReason: d.stopReason, api: d.api, project: d.folder, sessionFile: d.sessionFile }), ...focusTabs(this.ctx, width, sections.map((section) => section.title), this.section % sections.length), this.ctx.theme.fg("dim", `n section \xB7 v ${this.collapsed.has(selected.title) ? "expand" : "collapse"} \xB7 c/C copy \xB7 t trace \xB7 b/Esc back`), ...sections.flatMap((section) => [paneHeading(this.ctx, width, section.title, this.collapsed.has(section.title) ? "collapsed" : "", section === selected), ...this.collapsed.has(section.title) ? [] : [JSON.stringify(section.data, null, 2) ?? "null"]]));
    return wrap(lines, width);
  }
  sections(d) {
    const { messages, output, ...stats } = d;
    return [...output == null ? [] : [{ title: "Output message", data: output }], { title: "Session entry", data: messages }, { title: "Stats row", data: stats }];
  }
  handleInput(data) {
    if (!this.active || data === "q")
      return false;
    if (data === "b" || data === "\x1B") {
      this.close();
      return true;
    }
    if (data === "e" && this.error && this.row) {
      this.open(this.row);
      return true;
    }
    if (this.payload && (data === "n" || data === "v")) {
      const sections = this.sections(this.payload);
      if (data === "n")
        this.section = (this.section + 1) % sections.length;
      else {
        const title = sections[this.section % sections.length].title;
        this.collapsed.has(title) ? this.collapsed.delete(title) : this.collapsed.add(title);
      }
      this.ctx.changed();
      return true;
    }
    if (data === "t") {
      if (this.payload) {
        const d = this.payload;
        this.ctx.openTrace(d.sessionFile, d.entryId);
      }
      return true;
    }
    if (data === "c" || data === "C") {
      if (this.payload) {
        const generation = this.generation;
        const sections = this.sections(this.payload);
        const value = data === "C" ? sections[this.section % sections.length].data : this.payload;
        this.ctx.copy(JSON.stringify(value, null, 2)).then(() => this.copied(generation, "JSON copied successfully."), (error) => this.copied(generation, `Copy failed: ${String(error)}`));
      } else {
        this.notice = "Copy unavailable until request details load.";
        this.ctx.changed();
      }
      return true;
    }
    return false;
  }
  copied(generation, notice) {
    if (!this.disposed && this.active && generation === this.generation) {
      this.notice = notice;
      this.ctx.changed();
    }
  }
  close() {
    this.active = false;
    ++this.generation;
    this.payload = null;
    this.ctx.changed();
  }
  dispose() {
    this.disposed = true;
    this.active = false;
    ++this.generation;
    this.payload = null;
  }
}
var rowKey = (row) => String(row.id ?? `${row.sessionFile}:${row.entryId}`);
var statuses = ["all", "ok", "aborted", "failed"];
var sorters = {
  time: (r) => r.timestamp,
  model: (r) => r.model,
  provider: (r) => r.provider,
  project: (r) => r.folder,
  input: (r) => r.usage.input,
  cacheRead: (r) => r.usage.cacheRead,
  cacheWrite: (r) => r.usage.cacheWrite,
  output: (r) => r.usage.output,
  total: (r) => r.usage.totalTokens,
  premium: (r) => r.usage.premiumRequests ?? 0,
  cost: (r) => r.usage.cost.total,
  inputCost: (r) => r.usage.cost.input,
  outputCost: (r) => r.usage.cost.output,
  cacheReadCost: (r) => r.usage.cost.cacheRead,
  cacheWriteCost: (r) => r.usage.cost.cacheWrite,
  duration: (r) => r.duration ?? -1,
  ttft: (r) => r.ttft ?? -1,
  status: requestStatus,
  error: (r) => r.errorMessage ?? "",
  id: (r) => r.id ?? -1,
  entry: (r) => r.entryId,
  session: (r) => r.sessionFile,
  api: (r) => r.api,
  stop: (r) => r.stopReason,
  unpriced: (r) => Number(r.costUnpriced ?? false)
};
var signatureSorters = { count: (group) => group.count, signature: (group) => group.signature, models: (group) => group.models.length, last: (group) => group.lastSeen };
var requestColumns = [
  { key: "identity", header: "Request / model", align: "left", value: (r) => `#${r.id ?? "\u2013"} ${r.model} \xB7 ${r.provider}` },
  { key: "cost", header: "Estimate", align: "right", priority: 1, value: (r) => formatMessageCost(r) },
  { key: "tokens", header: "Tokens", align: "right", priority: 2, value: (r) => formatCompact(r.usage.totalTokens) },
  { key: "status", header: "Status", align: "left", priority: 3, value: requestStatus },
  { key: "duration", header: "Duration", align: "right", priority: 4, value: (r) => formatDurationMs(r.duration) },
  { key: "ttft", header: "TTFT", align: "right", priority: 5, value: (r) => formatDurationMs(r.ttft) },
  { key: "time", header: "Started", align: "left", priority: 6, value: (r) => formatTimestamp(r.timestamp) },
  { key: "project", header: "Project", align: "left", priority: 7, value: (r) => r.folder }
];
var errorColumns = [...requestColumns, { key: "error", header: "Error", align: "left", priority: 3, value: (r) => r.errorMessage ?? "\u2014" }];
function createRequestsFeature(id, ctx) {
  const details = new RequestDetails(ctx);
  const list = new ListState(rowKey, "time");
  list.descending = true;
  const signatures = new ListState((g) => g.signature, "count", 100);
  signatures.descending = true;
  const models = new ListState((m) => m.key, "count", 100);
  models.descending = true;
  const steps = id === "requests" ? [500, 2000, 1e4] : [50, 200, 1000];
  let rows = [], range = "24h", step = 0, generation = 0, closed = false, loading = false, error = null;
  let hasData = false;
  let status = 0, focus = 0, signature = null, model = null;
  const groups = () => groupErrorsBySignature(rows);
  const modelRows = () => {
    const map = new Map;
    for (const row of rows) {
      const key = modelKey(row.model, row.provider);
      const found = map.get(key);
      if (found)
        found.count++;
      else
        map.set(key, { key, model: row.model, provider: row.provider, count: 1 });
    }
    return models.rows([...map.values()], { count: (m) => m.count, model: (m) => m.model, provider: (m) => m.provider });
  };
  const visible = (grouped, allModels) => {
    const needle = list.search.trim().toLowerCase();
    const effectiveSignature = grouped.some((g) => g.signature === signature) ? signature : null;
    const effectiveModel = allModels.some((m) => m.key === model) ? model : null;
    return list.rows(rows.filter((r) => (id !== "requests" || status === 0 || requestStatus(r) === statuses[status]) && (id !== "errors" || (!effectiveSignature || errorSignature(r.errorMessage) === effectiveSignature) && (!effectiveModel || modelKey(r.model, r.provider) === effectiveModel)) && (!needle || [r.model, r.provider, r.folder, ...id === "errors" ? [r.errorMessage ?? ""] : []].some((value) => value.toLowerCase().includes(needle)))), sorters);
  };
  const load = async (nextRange) => {
    if (closed)
      return;
    range = nextRange;
    const request = ++generation;
    loading = true;
    error = null;
    ctx.changed();
    try {
      const result = await ctx.reader.api(id === "requests" ? "/api/stats/recent" : "/api/stats/errors", { range, limit: String(steps[step]) });
      if (closed || request !== generation)
        return;
      if (!Array.isArray(result)) {
        error = `${id === "requests" ? "Request" : "Error"} list payload is not an array`;
        return;
      }
      rows = result;
      hasData = true;
    } catch (caught) {
      if (closed || request !== generation)
        return;
      error = String(caught);
    } finally {
      if (!closed && request === generation) {
        loading = false;
        ctx.changed();
      }
    }
  };
  return {
    load,
    get inputMode() {
      return list.editing ? "text" : "navigation";
    },
    render(width, height) {
      const detail = details.render(width);
      if (detail)
        return detail;
      if (!hasData)
        return wrap([
          paneHeading(ctx, width, id === "requests" ? "Requests" : "Errors", range, true),
          ctx.theme.fg(error ? "error" : "dim", error ? `${error} \xB7 l retry` : loading ? "Loading observations\u2026" : "No observations loaded yet."),
          ...list.editing || list.search ? [`Search: ${list.search || "\u2014"} \xB7 Enter/Esc finish \xB7 Ctrl-U clear`] : []
        ], width);
      const grouped = groups();
      const allModels = modelRows();
      const filtered = visible(grouped, allModels);
      let hasTiming = false;
      const counts = { all: rows.length, ok: 0, aborted: 0, failed: 0 };
      for (const row of rows) {
        counts[requestStatus(row)]++;
        hasTiming ||= row.duration !== null && row.duration !== undefined;
      }
      const complete = !loading && !error && rows.length < steps[step];
      const summary = summarizeRequests(rows);
      const gs = signatures.rows(grouped, signatureSorters);
      const ms = allModels;
      const scope = complete ? `${formatInteger(rows.length)} of ${formatInteger(rows.length)} in ${range}` : `${formatInteger(rows.length)} loaded (total unavailable)`;
      const lines = [
        paneHeading(ctx, width, id === "requests" ? "Requests" : "Errors", range, true),
        ...metricRail(ctx, width, [
          { label: id === "errors" ? "Loaded failures" : "Loaded requests", value: formatInteger(rows.length), emphasis: "primary", hint: `${counts.ok} ok` },
          { label: "Matching", value: formatInteger(filtered.length), hint: id === "errors" ? `${gs.length} signatures` : `${counts.failed} failed` },
          { label: "API estimate", value: formatEstimatedCost(summary.cost, summary.unpriced), hint: `${formatInteger(summary.unpriced)} unpriced` },
          { label: "Tokens", value: formatCompact(summary.tokens), hint: `${counts.aborted} aborted` },
          { label: "Median latency", value: hasTiming ? formatDurationMs(summary.medianDuration) : "\u2014" },
          { label: "p95 latency", value: hasTiming ? formatDurationMs(summary.p95Duration) : "\u2014" }
        ], { maxRows: 2 })
      ];
      if (loading)
        lines.push(ctx.theme.fg("dim", "Loading\u2026 previous rows retained"));
      if (error)
        lines.push(ctx.theme.fg("error", `${error} \xB7 showing retained rows \xB7 l retry`));
      lines.push(ctx.theme.fg("dim", `${scope} \xB7 ${formatInteger(summary.unpriced)} unpriced`));
      lines.push(...focusTabs(ctx, width, id === "errors" ? ["Signatures", "Models", "Failures"] : ["Request log"], focus));
      lines.push(...wrap([ctx.theme.fg("dim", id === "requests" ? `Keys: f status ${statuses[status]} \xB7 / search \xB7 o/O sort \xB7 Enter details \xB7 l more` : "Keys: Tab pane \xB7 j/k select \xB7 Enter filter/open \xB7 / search \xB7 o/O sort \xB7 u latest \xB7 f/x/X clear")], width));
      const panelHeight = Math.max(5, height - lines.length);
      const failurePanel = id === "requests" || focus === 2 ? list.render(filtered, width, panelHeight, id === "errors" ? errorColumns : requestColumns, ctx, `${panePrefix(id === "requests" || focus === 2)}${id === "errors" ? "Failures" : "Request log"}`, { showHint: false }) : [];
      if (id === "requests") {
        lines.push(...failurePanel);
      } else {
        lines.push(`Signature: ${gs.some((group) => group.signature === signature) ? signature : "all"} \xB7 model: ${ms.some((row) => row.key === model) ? model : "all"}`);
        const panel = focus === 0 ? signatures.render(gs, width, panelHeight, [
          { key: "signature", header: "Error signature", align: "left", value: (g) => g.signature },
          { key: "count", header: "Failures", align: "right", value: (g) => formatInteger(g.count) },
          { key: "models", header: "Models", align: "right", priority: 2, value: (g) => formatInteger(g.models.length) },
          { key: "last", header: "Latest", align: "left", priority: 3, value: (g) => formatTimestamp(g.lastSeen) }
        ], ctx, `${panePrefix(focus === 0)}Error signatures`, { showHint: false }) : focus === 1 ? models.render(ms, width, panelHeight, [
          { key: "identity", header: "Model / provider", align: "left", value: (m) => `${m.model} \xB7 ${m.provider}` },
          { key: "count", header: "Failures", align: "right", value: (m) => formatInteger(m.count) }
        ], ctx, `${panePrefix(focus === 1)}Affected models`, { showHint: false }) : failurePanel;
        lines.push(...panel);
        const expanded = gs.find((group) => group.signature === signature);
        if (expanded) {
          lines.push(paneHeading(ctx, width, "Expanded signature", `${expanded.count} members`, false), expanded.signature, `First ${formatTimestamp(expanded.firstSeen)} \xB7 latest ${formatTimestamp(expanded.lastSeen)}`, `Latest error: ${expanded.latest.errorMessage ?? "\u2014"}`, ...expanded.models.map((member) => `${member.model} \xB7 ${member.provider}: ${member.count} failures`));
        }
      }
      return wrap(lines, width);
    },
    handleInput(data) {
      if (closed || !list.editing && (data === "q" || data === "[" || data === "]") || data === "\x1B[D" || data === "\x1B[C")
        return false;
      if (details.active)
        return details.handleInput(data);
      const grouped = groups();
      const allModels = modelRows();
      const filtered = visible(grouped, allModels);
      if (list.editing && (data === "\t" || data === "\x1B[Z") && id === "errors") {
        list.editing = false;
        focus = (focus + (data === "\t" ? 1 : 2)) % 3;
        ctx.changed();
        return true;
      }
      if (list.editing) {
        const consumed = list.input(data, filtered);
        if (consumed)
          ctx.changed();
        return consumed;
      }
      if (data === "l") {
        if (step + 1 < steps.length)
          step++;
        load(range);
        return true;
      }
      if (data === "f") {
        if (id === "requests")
          status = (status + 1) % statuses.length;
        else {
          signature = null;
          model = null;
          list.search = "";
        }
        ctx.changed();
        return true;
      }
      if (id === "errors" && (data === "x" || data === "X")) {
        if (data === "x")
          signature = null;
        else
          model = null;
        ctx.changed();
        return true;
      }
      if (data === "\x1B" && id === "errors" && (signature || model)) {
        signature = null;
        model = null;
        list.search = "";
        ctx.changed();
        return true;
      }
      if (data === "o" || data === "O") {
        const active = id !== "errors" || focus === 2 ? list : focus === 0 ? signatures : models;
        const keys = id !== "errors" || focus === 2 ? Object.keys(sorters) : focus === 0 ? Object.keys(signatureSorters) : ["count", "model", "provider"];
        if (data === "O")
          active.descending = !active.descending;
        else
          active.sort = keys[(keys.indexOf(active.sort) + 1) % keys.length];
        ctx.changed();
        return true;
      }
      if (id === "errors" && (data === "\t" || data === "\x1B[Z")) {
        focus = (focus + (data === "\t" ? 1 : 2)) % 3;
        ctx.changed();
        return true;
      }
      if (id === "errors" && data === "u") {
        const selected = grouped.find((group) => group.signature === signature);
        const latest = selected?.latest ?? rows.reduce((best, r) => !best || r.timestamp > best.timestamp ? r : best, undefined);
        if (latest)
          details.open(latest);
        return true;
      }
      if (data === "\r" || data === `
`) {
        if (id === "errors" && focus === 0) {
          const selected = signatures.current(signatures.rows(grouped, signatureSorters));
          if (selected)
            signature = signature === selected.signature ? null : selected.signature;
        } else if (id === "errors" && focus === 1) {
          const selected = models.current(allModels);
          if (selected)
            model = model === selected.key ? null : selected.key;
        } else {
          const selected = list.current(filtered);
          if (selected)
            details.open(selected);
        }
        ctx.changed();
        return true;
      }
      if (data === "/" && id === "errors")
        focus = 2;
      const consumed = data === "/" || data === "\x1B" || id === "requests" || focus === 2 ? list.input(data, filtered) : focus === 0 ? signatures.input(data, signatures.rows(grouped, signatureSorters)) : models.input(data, allModels);
      if (consumed)
        ctx.changed();
      return consumed;
    },
    dispose() {
      closed = true;
      ++generation;
      details.dispose();
    }
  };
}

// node_modules/@oh-my-pi/omp-stats/src/client/data/range.ts
var MINUTE_MS = 60 * 1000;
var HOUR_MS = 60 * MINUTE_MS;
var DAY_MS = 24 * HOUR_MS;
var RANGE_META = {
  "1h": { label: "1h", windowLabel: "the last hour", spanMs: HOUR_MS, bucketMs: 5 * MINUTE_MS },
  "24h": { label: "24h", windowLabel: "the last 24 hours", spanMs: DAY_MS, bucketMs: HOUR_MS },
  "7d": { label: "7d", windowLabel: "the last 7 days", spanMs: 7 * DAY_MS, bucketMs: DAY_MS },
  "30d": { label: "30d", windowLabel: "the last 30 days", spanMs: 30 * DAY_MS, bucketMs: DAY_MS },
  "90d": { label: "90d", windowLabel: "the last 90 days", spanMs: 90 * DAY_MS, bucketMs: DAY_MS },
  all: { label: "All", windowLabel: "all time", spanMs: null, bucketMs: DAY_MS }
};
var MAX_BUCKETS = 1500;
function rangeMeta(range) {
  return RANGE_META[range];
}
function bucketAxis(range, dataTimestamps, bucketMs = RANGE_META[range].bucketMs, now = Date.now()) {
  const last = Math.floor(now / bucketMs) * bucketMs;
  const span = RANGE_META[range].spanMs;
  let first;
  if (span !== null) {
    first = Math.floor((now - span) / bucketMs) * bucketMs;
  } else {
    first = last;
    for (const ts of dataTimestamps)
      if (ts < first)
        first = ts;
    first = Math.floor(first / bucketMs) * bucketMs;
  }
  first = Math.max(first, last - (MAX_BUCKETS - 1) * bucketMs);
  const buckets = [];
  for (let t = first;t <= last; t += bucketMs)
    buckets.push(t);
  return buckets;
}

// src/tui/features/core/analytics.ts
var COMPONENTS = [
  { key: "costInput", label: "Input" },
  { key: "costOutput", label: "Output" },
  { key: "costCacheRead", label: "Cache read" },
  { key: "costCacheWrite", label: "Cache write" }
];
var DAY_MS2 = 86400000;
var row = (key, label, values, display = values, tool) => ({ key, label, values, display, tool });
var table = (title, sort, limit) => ({ title, state: new ListState((r) => r.key, sort, limit), rows: [] });
var sorters2 = (rows) => {
  const keys = new Set(rows.flatMap((r) => Object.keys(r.values)));
  return Object.fromEntries([...keys].map((key) => [key, (r) => {
    const value = r.values[key];
    return typeof value === "number" || typeof value === "string" ? value : null;
  }]));
};
var denseSeries = (series) => series.map((s) => ({ key: s.key, label: s.label, values: s.values.map((v) => v ?? 0) }));
var shares = (series, totals) => series.map((s) => ({ ...s, values: s.values.map((v, i) => totals[i] > 0 && v !== null ? v / totals[i] : null) }));
var identity = (model, provider) => `${model || "(unknown)"} \xB7 ${provider}`;
function reportBucketHits(ctx, lines, groups) {
  for (const group of groups) {
    const heading = lines.findIndex((line) => line.includes(group.marker));
    if (heading < 0)
      continue;
    const rowOffset = heading + group.chartStart;
    const colShift = group.colShift ?? 0;
    ctx.reportHits?.(group.spans.map((span) => ({
      rowStart: span.rowStart + rowOffset,
      rowEnd: span.rowEnd + rowOffset,
      colStart: span.colStart + colShift,
      colEnd: span.colEnd + colShift,
      action: { type: "selectBucket", series: group.series, index: span.index }
    })));
  }
}

class AnalyticsFeature {
  id;
  ctx;
  closed = false;
  generation = 0;
  loading = false;
  error = null;
  range = "24h";
  focus = 0;
  expanded = null;
  chart = new ChartState;
  performanceChart = new ChartState;
  trendChart = new ChartState;
  detailMode = "performance";
  trends = new Map;
  tables;
  performancePoints = 0;
  buckets = [];
  modes = [];
  metrics = [];
  performance = new Map;
  unpriced = [];
  costSeriesUnknown = new Map;
  costs = null;
  toolFilter = null;
  toolNames = [];
  constructor(id, ctx) {
    this.id = id;
    this.ctx = ctx;
    this.tables = id === "models" ? [table("All models", "totalRequests", 25)] : id === "costs" ? [table("By model", "cost", 20), table("Billing components", "cost", 4)] : [table("By tool", "calls", 20), table("By tool and model", "calls", 25)];
  }
  async load(range) {
    if (this.closed)
      return;
    const generation = ++this.generation;
    this.range = range;
    this.loading = true;
    this.error = null;
    this.ctx.changed();
    try {
      if (this.id === "models") {
        const data = await this.ctx.reader.api("/api/stats/model-dashboard", { range });
        if (this.closed || generation !== this.generation)
          return;
        this.setModels(data, range);
      } else if (this.id === "costs") {
        const data = await this.ctx.reader.api("/api/stats/costs", { range });
        if (this.closed || generation !== this.generation)
          return;
        this.setCosts(data, range);
      } else {
        const data = await this.ctx.reader.api("/api/stats/tools", { range });
        if (this.closed || generation !== this.generation)
          return;
        this.setTools(data, range);
      }
      this.chart.reconcile(this.buckets, this.mode()?.series.map((series) => series.key) ?? []);
      for (let i = 0;i < this.tables.length; i++) {
        const t = this.tables[i];
        if (t.state.selected === null)
          t.state.selected = this.rows(i)[0]?.key ?? null;
      }
    } catch (error) {
      if (!this.closed && generation === this.generation)
        this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (!this.closed && generation === this.generation) {
        this.loading = false;
        this.ctx.changed();
      }
    }
  }
  axis(range, timestamps, bucketMs = rangeMeta(range).bucketMs) {
    return bucketAxis(range, timestamps, bucketMs, this.ctx.now());
  }
  setModels(data, range) {
    const timestamps = data.modelSeries.map((p) => p.timestamp);
    this.buckets = this.axis(range, timestamps);
    this.chart.seedLatestPoint(this.buckets, timestamps);
    const counts = denseSeries(pivotSeries(data.modelSeries, { buckets: this.buckets, key: (p) => modelKey(p.model, p.provider), label: (key) => {
      const m = data.byModel.find((m) => modelKey(m.model, m.provider) === key);
      return m ? identity(m.model, m.provider) : key;
    }, value: (p) => p.requests, limit: 6 }));
    const totals = densify(data.modelSeries, this.buckets, (p) => p.requests);
    this.modes = [{ label: "Request share", series: shares(counts, totals), unit: "share" }, { label: "Request counts", series: counts, unit: "requests" }];
    this.performance = buildModelPerformanceLookup(data.modelPerformanceSeries);
    this.trends = new Map(denseSeries(pivotSeries(data.modelSeries, { buckets: this.buckets, key: (p) => modelKey(p.model, p.provider), label: (key) => {
      const model = data.byModel.find((model) => modelKey(model.model, model.provider) === key);
      return model ? identity(model.model, model.provider) : key;
    }, value: (p) => p.requests })).map((series) => [series.key, series]));
    this.tables[0].rows = data.byModel.map((m) => row(modelKey(m.model, m.provider), identity(m.model, m.provider), { ...m, conversationTokens: sumConversationTokens(m) }, {
      ...m,
      totalCost: formatEstimatedCost(m.totalCost, m.unpricedRequests),
      errorRate: formatPercent(m.errorRate),
      cacheRate: formatPercent(m.cacheRate),
      cacheSavings: formatPercent(m.cacheSavings),
      avgDuration: formatDurationMs(m.avgDuration),
      avgTtft: formatDurationMs(m.avgTtft),
      avgTokensPerSecond: `${formatTokensPerSecond(m.avgTokensPerSecond)} tok/s`,
      conversationTokens: sumConversationTokens(m)
    }));
    const sum = (key) => data.byModel.reduce((total, m) => total + m[key], 0);
    this.metrics = [
      { label: "Requests", value: formatInteger(sum("totalRequests")), emphasis: "primary", spark: totals },
      { label: "Models", value: formatInteger(data.byModel.length), hint: `${new Set(data.byModel.map((m) => m.provider)).size} providers` },
      { label: "Failed", value: formatInteger(sum("failedRequests")) },
      { label: "API estimate", value: formatEstimatedCost(sum("totalCost"), sum("unpricedRequests")), hint: `${formatInteger(sum("unpricedRequests"))} unpriced` }
    ];
  }
  setCosts(data, range) {
    this.costs = data;
    const summary = buildCostSummary(data.costSeries);
    const timestamps = data.costSeries.map((p) => p.timestamp);
    this.buckets = this.axis(range, timestamps, DAY_MS2);
    this.chart.seedLatestPoint(this.buckets, timestamps);
    this.unpriced = densify(data.costSeries, this.buckets, (p) => p.unpricedRequests);
    const byKey = new Map(summary.models.map((m) => [m.key, m]));
    const models = denseSeries(pivotSeries(data.costSeries, { buckets: this.buckets, key: (p) => modelKey(p.model, p.provider), label: (key) => {
      const m = byKey.get(key);
      return m ? identity(m.model, m.provider) : key;
    }, value: (p) => p.cost, limit: 6 }));
    const individualKeys = new Set(models.filter((s) => s.key !== "__other__").map((s) => s.key));
    this.costSeriesUnknown = new Map(models.map((s) => [s.key, densify(data.costSeries, this.buckets, (p) => {
      const key = modelKey(p.model, p.provider);
      return (s.key === "__other__" ? !individualKeys.has(key) : key === s.key) ? p.unpricedRequests : 0;
    })]));
    this.modes = [{ label: "Daily estimate by model (UTC)", series: models, unit: "USD" }, { label: "Daily estimate by component (UTC)", series: COMPONENTS.map((c) => ({ ...c, values: densify(data.costSeries, this.buckets, (p) => p[c.key]) })), unit: "USD" }];
    this.tables[0].rows = summary.models.map((m) => {
      const perPricedRequest = m.requests > m.unpricedRequests ? m.cost / (m.requests - m.unpricedRequests) : null;
      return row(m.key, identity(m.model, m.provider), { ...m, perPricedRequest }, { ...m, cost: `${formatEstimatedCost(m.cost, m.unpricedRequests)} \xB7 Unknown requests: ${formatInteger(m.unpricedRequests)}`, share: m.cost === 0 && m.unpricedRequests > 0 ? "N/A" : `${formatPercent(m.share)} of priced estimate`, ...Object.fromEntries(COMPONENTS.map((c) => [c.key, `${formatEstimatedCost(m[c.key], m.unpricedRequests)} \xB7 Unknown requests: ${formatInteger(m.unpricedRequests)}`])), perPricedRequest: `${perPricedRequest === null ? "N/A" : perPricedRequest > 0 && perPricedRequest < 0.0001 ? "<$0.0001" : formatCost(perPricedRequest)} \xB7 Unknown requests excluded: ${formatInteger(m.unpricedRequests)}` });
    });
    this.tables[1].rows = COMPONENTS.map((c) => {
      const values = { component: c.label, cost: summary[c.key], share: summary.totalCost > 0 ? summary[c.key] / summary.totalCost : 0, unpricedRequests: summary.unpricedRequests };
      return row(c.key, c.label, values, { ...values, cost: `${formatEstimatedCost(values.cost, summary.unpricedRequests)} \xB7 Unknown requests: ${formatInteger(summary.unpricedRequests)}`, share: summary.totalCost > 0 ? `${formatPercent(values.share)} of priced estimate` : "N/A" });
    });
    const priced = summary.requests - summary.unpricedRequests;
    this.metrics = [
      { label: "API estimate", value: formatEstimatedCost(summary.totalCost, summary.unpricedRequests), emphasis: "primary", hint: "Public API rates", spark: densify(data.costSeries, this.buckets, (p) => p.cost) },
      { label: "Requests", value: formatInteger(summary.requests), hint: `${formatInteger(summary.unpricedRequests)} unpriced` },
      { label: "Per active day", value: formatEstimatedCost(summary.avgDailyCost, summary.unpricedRequests), hint: `${summary.activeDays} active UTC days` },
      { label: "Per priced request", value: priced > 0 ? formatCost(summary.totalCost / priced) : "N/A", hint: "Priced requests only" }
    ];
  }
  setTools(data, range) {
    const timestamps = data.series.map((p) => p.timestamp);
    this.buckets = this.axis(range, timestamps);
    this.chart.seedLatestPoint(this.buckets, timestamps);
    const calls = denseSeries(pivotSeries(data.series, { buckets: this.buckets, key: (p) => p.tool, value: (p) => p.calls, limit: 6 }));
    const errors = denseSeries(pivotSeries(data.series, { buckets: this.buckets, key: (p) => p.tool, value: (p) => p.errors, limit: 6 }));
    this.modes = [{ label: "Tool call counts (all tools)", series: calls, unit: "calls" }, { label: "Tool error counts (all tools)", series: errors, unit: "errors" }, { label: "Tool call share (all tools)", series: shares(calls, densify(data.series, this.buckets, (p) => p.calls)), unit: "share" }, { label: "Tool error share (all tools)", series: shares(errors, densify(data.series, this.buckets, (p) => p.errors)), unit: "share" }];
    this.trends = new Map(denseSeries(pivotSeries(data.series, { buckets: this.buckets, key: (p) => p.tool, value: (p) => p.calls })).map((series) => [series.key, series]));
    const display = (t) => ({ ...t, costShare: formatEstimatedCost(t.costShare, t.unpricedRequestsShare), errorRate: formatPercent(t.errorRate), callFraction: formatPercent(t.callFraction), tokenFraction: formatPercent(t.tokenFraction), costFraction: formatPercent(t.costFraction) });
    this.tables[0].rows = buildToolRows(data.byTool).map((t) => row(t.tool, t.tool, { ...t }, display(t), t.tool));
    this.tables[1].rows = buildToolRows(data.byToolModel).map((t, i) => {
      const m = data.byToolModel[i];
      return row(JSON.stringify([m.tool, modelKey(m.model, m.provider)]), `${m.tool} \xB7 ${identity(m.model, m.provider)}`, { ...m, ...t }, { ...m, ...display(t) }, m.tool);
    });
    this.toolNames = data.byTool.map((t) => t.tool).sort((a, b) => a.localeCompare(b));
    const totals = data.byTool.reduce((s, t) => ({ calls: s.calls + t.calls, errors: s.errors + t.errors, tokens: s.tokens + t.totalTokensShare, output: s.output + t.outputTokensShare, cost: s.cost + t.costShare, unpriced: s.unpriced + t.unpricedRequestsShare, result: s.result + t.resultChars, args: s.args + t.argsChars }), { calls: 0, errors: 0, tokens: 0, output: 0, cost: 0, unpriced: 0, result: 0, args: 0 });
    this.metrics = [
      { label: "Tool calls", value: formatInteger(totals.calls), emphasis: "primary", hint: `${data.byTool.length} distinct tools`, spark: densify(data.series, this.buckets, (p) => p.calls) },
      { label: "Errors", value: formatInteger(totals.errors), hint: formatPercent(totals.calls > 0 ? totals.errors / totals.calls : 0) },
      { label: "Attributed tokens", value: formatCompact(totals.tokens), hint: `${formatCompact(totals.output)} output` },
      { label: "API estimate", value: formatEstimatedCost(totals.cost, totals.unpriced), hint: `${formatInteger(totals.unpriced)} unpriced` },
      { label: "Result text", value: `${formatCompact(totals.result)} chars`, hint: `${formatCompact(totals.calls > 0 ? Math.round(totals.result / totals.calls) : 0)} / call` },
      { label: "Call arguments", value: `${formatCompact(totals.args)} chars`, hint: `${formatCompact(totals.calls > 0 ? Math.round(totals.args / totals.calls) : 0)} / call` }
    ];
  }
  rows(index) {
    const t = this.tables[index];
    const search = t.state.search.toLocaleLowerCase();
    const filter = this.toolFilter !== null && this.toolNames.includes(this.toolFilter) ? this.toolFilter : null;
    return t.state.rows(t.rows.filter((r) => (this.id !== "tools" || index !== 1 || filter === null || r.tool === filter) && (!search || `${r.label} ${fields(r.values).join(" ")}`.toLocaleLowerCase().includes(search))), sorters2(t.rows));
  }
  sparkSeries() {
    if (this.id === "costs") {
      const mode = this.mode();
      return new Map((mode?.series ?? []).map((s) => [s.key, s]));
    }
    return this.trends;
  }
  mode() {
    return this.modes[this.chart.mode % Math.max(1, this.modes.length)];
  }
  render(width, height) {
    const lines = [paneHeading(this.ctx, width, this.id[0].toUpperCase() + this.id.slice(1), this.range, true)];
    const filter = this.toolFilter !== null && this.toolNames.includes(this.toolFilter) ? this.toolFilter : null;
    if (this.loading)
      lines.push(this.ctx.theme.fg("dim", "Loading\u2026 Previous observations remain visible."));
    if (this.error)
      lines.push(this.ctx.theme.fg("error", this.error));
    if (this.expanded) {
      const selected = this.rows(this.expanded.table).find((r) => r.key === this.expanded?.key);
      if (selected) {
        const pending = [];
        lines.push(paneHeading(this.ctx, width, `Details: ${selected.label}`, "", true));
        if (this.id === "models" && this.detailMode === "performance")
          lines.push(...this.renderPerformance(selected.key, width, pending), "m requests trend");
        else if (this.id === "models" || this.id === "tools") {
          const trend = this.trends.get(this.id === "tools" ? selected.tool ?? selected.key : selected.key);
          const trendHeading = this.id === "tools" ? "Tool call trend (all models)" : "Model request trend";
          lines.push(trendHeading);
          const trendKey = this.trendChart.selectedKey ?? (trend ? trend.key : "") ?? "";
          lines.push(...this.trendChart.render(this.ctx, width, this.buckets, trend ? [trend] : [], {
            height: 5,
            unit: this.id === "tools" ? "calls" : "requests",
            format: formatInteger,
            showHint: false,
            reportBuckets: (spans) => pending.push({ spans: [...spans], marker: trendHeading, chartStart: 1, series: trendKey })
          }), ...this.id === "models" ? ["m performance chart"] : []);
        }
        lines.push(...fields(selected.display));
        lines.push("b/Esc back \xB7 Tab focus \xB7 q close");
        const finalLines = wrap(lines, width);
        reportBucketHits(this.ctx, finalLines, pending);
        return finalLines;
      }
    }
    const metrics = metricRail(this.ctx, width, this.metrics, { maxRows: 2 });
    const prefix = [...lines, ...metrics];
    if (this.id === "costs")
      prefix.push(...wrap([this.ctx.theme.fg("dim", `${formatInteger(this.unpriced.reduce((total, count) => total + count, 0))} unpriced \xB7 API estimate excludes unpriced usage, not free`)], width));
    if (this.id === "tools")
      prefix.push(...wrap([this.ctx.theme.fg("dim", "Attribution: invoking-turn tokens/cost split across tool calls.")], width));
    const tabs = focusTabs(this.ctx, width, ["Chart", ...this.tables.map((table) => table.title)], this.focus);
    const active = this.focus > 0 ? this.tables[this.focus - 1] : null;
    const cue = wrap([this.ctx.theme.fg("dim", this.focus === 0 ? "m mode \xB7 n legend \xB7 v visibility \xB7 ,/. point \xB7 Tab pane" : active?.state.editing || active?.state.search ? "Keys: search \xB7 Enter/Esc finish \xB7 Ctrl-U clear \xB7 Tab pane" : this.id === "tools" ? "/ search \xB7 j/k select \xB7 Enter filter \xB7 d details \xB7 f/x tool \xB7 o/O sort \xB7 Tab pane" : `/ search \xB7 j/k select \xB7 Enter details \xB7 o/O sort \xB7 Tab pane`)], width);
    const base = [...prefix, "", ...tabs, ...cue, ""];
    const mode = this.mode();
    const hasRows = this.tables.some((table) => table.rows.length > 0);
    const showTable = Boolean(mode) || hasRows;
    const tableIndexes = [];
    for (let i = 0;i < this.tables.length; i++) {
      if (this.tables.every((table) => table.rows.length === 0) && (this.focus > 0 || i > 0))
        continue;
      tableIndexes.push(i);
    }
    const available = Math.max(8, height - base.length - 1);
    const chartOverhead = mode ? 4 + mode.series.length : 0;
    const chartPlot = mode ? Math.max(4, Math.round(available * (tableIndexes.length ? 0.45 : 1)) - chartOverhead) : 0;
    const wide = width >= 80 && Boolean(mode) && showTable;
    const leftWidth = Math.floor((width - 2) / 2);
    const rightWidth = width - 2 - leftWidth;
    const chartWidth = wide ? this.focus === 0 ? leftWidth : rightWidth : width;
    const tableWidth = wide ? this.focus === 0 ? rightWidth : leftWidth : width;
    const pending = [];
    let chartBlock = [];
    if (mode) {
      this.chart.reconcile(this.buckets, mode.series.map((series) => series.key));
      const chartHeading = paneHeading(this.ctx, chartWidth, "Chart", mode.label, this.focus === 0);
      chartBlock = [chartHeading];
      const unknown = this.unpriced.reduce((total, count) => total + count, 0);
      if (this.id === "costs" && unknown > 0 && mode.series.every((s) => s.values.every((value) => value === 0)))
        chartBlock.push(...wrap([`No priced cost / unknown ${formatInteger(unknown)} requests. Unpriced usage is not zero spend.`], chartWidth));
      const chartStart = chartBlock.length;
      const seriesKey = this.chart.selectedKey ?? mode.series[0]?.key ?? "";
      const colShift = wide && this.focus !== 0 ? leftWidth + 2 : 0;
      chartBlock.push(...this.chart.render(this.ctx, chartWidth, this.buckets, mode.series, {
        unit: mode.unit === "USD" ? "known-priced USD / day" : mode.unit,
        percent: mode.unit === "share",
        stacked: true,
        format: mode.unit === "USD" ? formatCost : mode.unit === "share" ? formatPercent : formatCompact,
        height: chartPlot,
        showHint: false,
        formatValue: mode.unit === "USD" ? (key, value, point) => value === null || value === undefined ? "\u2014" : formatEstimatedCost(value, this.chart.mode % 2 === 0 ? this.costSeriesUnknown.get(key)?.[point] ?? 0 : this.unpriced[point] ?? 0) : undefined,
        reportBuckets: (spans) => pending.push({ spans: [...spans], marker: chartHeading, chartStart, series: seriesKey, colShift })
      }));
      this.chart.point = Math.min(this.chart.point, Math.max(0, this.buckets.length - 1));
      const point = this.chart.point;
      if (this.id === "costs" && this.buckets.length) {
        const timestamp = this.buckets[point];
        chartBlock.push(...wrap([this.ctx.theme.fg("dim", `${formatInteger(this.unpriced[point] ?? 0)} unpriced in selected UTC day`)], chartWidth));
        for (const p of this.costs?.costSeries ?? [])
          if (p.timestamp === timestamp && p.unpricedRequests > 0)
            chartBlock.push(...wrap([`${identity(p.model, p.provider)} \xB7 ${formatEstimatedCost(p.cost, p.unpricedRequests)} \xB7 ${formatInteger(p.unpricedRequests)} unpriced`], chartWidth));
      }
    }
    const tableHeight = Math.max(5, Math.floor((available - chartBlock.length) / Math.max(1, tableIndexes.length)));
    const focusIndex = this.focus > 0 ? this.focus - 1 : Math.min(0, this.tables.length - 1);
    const focusedTable = showTable ? this.renderTable(focusIndex, tableWidth, tableHeight, filter, this.focus > 0) : [];
    const pair = [];
    if (wide) {
      const chartFirst = this.focus === 0;
      pair.push(...sideBySide(this.ctx, width, chartFirst ? chartBlock : focusedTable, chartFirst ? focusedTable : chartBlock));
    } else {
      const first = this.focus === 0 ? chartBlock : focusedTable;
      const second = this.focus === 0 ? focusedTable : chartBlock;
      if (first.length)
        pair.push(...first);
      if (second.length) {
        if (pair.length)
          pair.push("");
        pair.push(...second);
      }
    }
    const trailing = [];
    for (const index of tableIndexes)
      if (index !== focusIndex) {
        if (trailing.length)
          trailing.push("");
        trailing.push(...this.renderTable(index, width, tableHeight, filter, false));
      }
    const finalLines = wrap([...base, ...pair, ...trailing.length ? ["", ...trailing] : []], width);
    reportBucketHits(this.ctx, finalLines, pending);
    return finalLines;
  }
  renderTable(index, width, height, filter, active = false) {
    const table = this.tables[index];
    const numeric = (key, header, priority = 0) => ({
      key,
      header,
      align: "right",
      priority,
      value: (row) => {
        const value = row.display[key];
        return typeof value === "number" ? Math.abs(value) < 1e4 ? formatInteger(value) : formatCompact(value) : value == null ? "\u2014" : String(value).split(" \xB7 ")[0];
      }
    });
    const columns = [{ key: "identity", header: this.id === "tools" ? "Tool / model" : index === 1 ? "Component" : "Model / provider", align: "left", value: (row) => row.label }];
    if (index === 0)
      columns.push({ key: "trend", header: "Trend", align: "left", priority: 8, value: (row) => sparkCell(this.sparkSeries().get(row.key)?.values ?? []) });
    if (this.id === "models")
      columns.push(numeric("totalRequests", "Requests"), numeric("totalCost", "Estimate", 1), numeric("errorRate", "Errors", 3), numeric("conversationTokens", "Tokens", 4), numeric("avgDuration", "Duration", 5), numeric("avgTtft", "TTFT", 6), numeric("avgTokensPerSecond", "tok/s", 7));
    else if (this.id === "costs")
      columns.push(numeric("cost", "Estimate"), numeric("unpricedRequests", "Unpriced", 1), numeric("share", "Share", 3), ...index === 0 ? [numeric("requests", "Requests", 2), numeric("perPricedRequest", "/ priced req", 4)] : []);
    else
      columns.push(numeric("calls", "Calls"), numeric("errors", "Errors", 2), numeric("costShare", "Estimate", 1), numeric("totalTokensShare", "Tokens", 3), numeric("errorRate", "Error %", 4));
    const title = table.title + (this.id === "tools" && index === 1 ? ` \xB7 Tool filter: ${filter ?? "All tools"}` : "");
    return [...table.state.render(this.rows(index), width, Math.max(1, height), columns, this.ctx, `${panePrefix(active)}${title}`, { showHint: false })];
  }
  renderPerformance(key, width, pending) {
    const points = this.performance.get(key) ?? [];
    this.performancePoints = points.length;
    if (!points.length)
      return ["No performance samples. Timing is recorded for streamed responses."];
    this.performanceChart.reconcile(points.map((point) => point.timestamp), ["tps", "ttft"]);
    const p = points[this.performanceChart.point];
    const series = [{ key: "tps", label: "Throughput (tok/s)", values: points.map((p) => p.avgTokensPerSecond) }, { key: "ttft", label: "TTFT (seconds)", values: points.map((p) => p.avgTtftSeconds) }];
    const legend = series.map((s, i) => `${i === this.performanceChart.seriesIndex % series.length ? ">" : " "} ${this.performanceChart.hidden.has(s.key) ? "off" : "on"} ${s.label}`);
    const lines = [...metricRail(this.ctx, width, [
      { label: "Throughput", value: `${formatTokensPerSecond(p.avgTokensPerSecond)} tok/s`, emphasis: "primary" },
      { label: "TTFT", value: p.avgTtftSeconds === null ? "\u2014" : formatDurationMs(p.avgTtftSeconds * 1000) },
      { label: "Requests", value: formatInteger(p.requests), hint: new Date(p.timestamp).toISOString() }
    ], { maxRows: 2 }), ...legend];
    for (let i = 0;i < series.length; i++) {
      const s = series[i];
      if (this.performanceChart.hidden.has(s.key))
        continue;
      const marker = legend[i];
      lines.push(...renderTimeSeries(this.ctx, points.map((point) => point.timestamp), [s], width, this.performanceChart.point, {
        height: 4,
        unit: s.key === "tps" ? "tok/s" : "s",
        format: (value) => s.key === "tps" ? formatTokensPerSecond(value) : formatDurationMs(value * 1000),
        legend: false,
        reportBuckets: (spans) => pending.push({ spans: [...spans], marker, chartStart: 1, series: s.key })
      }));
    }
    lines.push("n/v series \xB7 ,/. point");
    return lines;
  }
  get inputMode() {
    return this.tables[this.focus - 1]?.state.editing ? "text" : "navigation";
  }
  handleInput(data) {
    if (this.closed || this.inputMode !== "text" && (data === "q" || data === "[" || data === "]") || data === "\x1B[C" || data === "\x1B[D")
      return false;
    const active = this.focus > 0 ? this.tables[this.focus - 1] : null;
    let consumed = false;
    if (active?.state.editing && data !== "\t" && data !== "\x1B[Z")
      consumed = active.state.input(data, this.rows(this.focus - 1));
    else if (data === "\t" || data === "\x1B[Z") {
      if (active)
        active.state.editing = false;
      this.focus = (this.focus + (data === "\t" ? 1 : this.tables.length)) % (this.tables.length + 1);
      consumed = true;
    } else if (data === "b" || data === "\x1B") {
      if (this.expanded) {
        this.expanded = null;
        consumed = true;
      } else if (active?.state.search) {
        active.state.search = "";
        consumed = true;
      } else if (this.toolFilter !== null) {
        this.toolFilter = null;
        consumed = true;
      } else if (this.focus !== 0) {
        this.focus = 0;
        consumed = true;
      }
    } else if (this.id === "tools" && (data === "f" || data === "x")) {
      if (data === "x")
        this.toolFilter = null;
      else
        this.toolFilter = this.toolNames[this.toolFilter === null ? 0 : this.toolNames.indexOf(this.toolFilter) + 1] ?? null;
      this.expanded = null;
      consumed = true;
    } else if (this.expanded && this.rows(this.expanded.table).some((row) => row.key === this.expanded?.key) && (this.id === "models" || this.id === "tools")) {
      const selected = this.rows(this.expanded.table).find((row) => row.key === this.expanded?.key);
      if (this.id === "models" && data === "m") {
        this.detailMode = this.detailMode === "performance" ? "trend" : "performance";
        consumed = true;
      } else if (this.id === "models" && this.detailMode === "performance")
        consumed = this.performanceChart.input(data, ["tps", "ttft"]);
      else
        consumed = this.trendChart.input(data, selected ? [this.id === "tools" ? selected.tool ?? selected.key : selected.key] : []);
    } else if (data === "m") {
      this.chart.mode = (this.chart.mode + 1) % Math.max(1, this.modes.length);
      consumed = true;
    } else if (this.focus === 0)
      consumed = this.chart.input(data, this.mode()?.series.map((s) => s.key) ?? []);
    else if (active) {
      const rows = this.rows(this.focus - 1);
      if (data === "o" || data === "O") {
        if (data === "O")
          active.state.descending = !active.state.descending;
        else {
          const keys = Object.keys(sorters2(active.rows));
          active.state.sort = keys[(keys.indexOf(active.state.sort) + 1) % Math.max(1, keys.length)] ?? active.state.sort;
        }
        consumed = true;
      } else if (data === "\r" || data === `
` || this.id === "tools" && data === "d") {
        const selected = active.state.current(rows);
        if (selected) {
          active.state.selected = selected.key;
          if (this.id === "tools" && this.focus === 1 && data !== "d") {
            this.toolFilter = this.toolFilter === selected.tool ? null : selected.tool ?? null;
            this.expanded = null;
          } else
            this.expanded = this.expanded?.table === this.focus - 1 && this.expanded.key === selected.key ? null : { table: this.focus - 1, key: selected.key };
        }
        consumed = true;
      } else
        consumed = active.state.input(data, rows);
    }
    if (consumed)
      this.ctx.changed();
    return consumed;
  }
  handleHit(action) {
    if (action.type !== "selectBucket")
      return;
    if ((action.series === "tps" || action.series === "ttft") && this.performancePoints > 0) {
      this.performanceChart.selectPoint(action.index, this.performancePoints);
    } else if (this.buckets.length) {
      if (action.series === this.trendChart.selectedKey)
        this.trendChart.selectPoint(action.index, this.buckets.length);
      else
        this.chart.selectPoint(action.index, this.buckets.length);
    }
    this.ctx.changed();
  }
  dispose() {
    this.closed = true;
    this.generation++;
  }
}
function sparkCell(values) {
  return renderSparkline(values, { width: 12 });
}
function createAnalyticsFeature(id, ctx) {
  return new AnalyticsFeature(id, ctx);
}

// src/tui/charts/calendar.ts
var MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function localDay(date) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}
function addDays(date, days) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}
function layoutKey(weeks, today) {
  return `${weeks} ${localDay(today)} ${today.getTimezoneOffset()}`;
}
var LAYOUT_CACHE_LIMIT = 16;
var layoutCache = new WeakMap;
var __testing = { layoutBuilds: 0 };
function cacheLookup(points, key) {
  const entries = layoutCache.get(points);
  if (!entries)
    return;
  const hit = entries.get(key);
  if (hit === undefined)
    return;
  entries.delete(key);
  entries.set(key, hit);
  return hit;
}
function cacheStore(points, key, layout) {
  let entries = layoutCache.get(points);
  if (!entries) {
    entries = new Map;
    layoutCache.set(points, entries);
  }
  entries.delete(key);
  entries.set(key, layout);
  while (entries.size > LAYOUT_CACHE_LIMIT) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined)
      break;
    entries.delete(oldest);
  }
}
function calendarLayout(points, weeks, today = new Date) {
  const key = layoutKey(weeks, today);
  const cached = cacheLookup(points, key);
  if (cached !== undefined)
    return cached;
  const layout = buildLayout(points, weeks, today);
  __testing.layoutBuilds++;
  cacheStore(points, key, layout);
  return layout;
}
function buildLayout(points, weeks, today) {
  const byDay = new Map(points.map((point) => [point.day, point]));
  const anyCost = points.some((point) => point.cost > 0);
  const metric = (point) => anyCost ? point.cost : point.requests;
  const today0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const mondayOffset = (today0.getDay() + 6) % 7;
  const currentMonday = addDays(today0, -mondayOffset);
  const start = addDays(currentMonday, -(weeks - 1) * 7);
  const startDay = localDay(start);
  const todayDay = localDay(today0);
  const inRange = points.filter((point) => point.day >= startDay && point.day <= todayDay);
  const max = inRange.reduce((acc, point) => Math.max(acc, metric(point)), 0);
  const level = (value) => {
    if (value <= 0 || max <= 0)
      return 0;
    return Math.min(4, Math.max(1, Math.ceil(Math.sqrt(value / max) * 4)));
  };
  const monthLabels = [];
  const cells = Array.from({ length: 7 }, () => Array.from({ length: weeks }, () => null));
  let previousMonth = -1;
  for (let week = 0;week < weeks; week++) {
    const weekStart = addDays(start, week * 7);
    const month = weekStart.getMonth();
    monthLabels.push(month !== previousMonth ? MONTH_NAMES[month] : undefined);
    previousMonth = month;
    for (let day = 0;day < 7; day++) {
      const date = addDays(weekStart, day);
      if (date > today0)
        continue;
      const point = byDay.get(localDay(date));
      cells[day][week] = level(point ? metric(point) : 0);
    }
  }
  return {
    monthLabels,
    cells,
    totalCost: inRange.reduce((sum, point) => sum + point.cost, 0),
    totalRequests: inRange.reduce((sum, point) => sum + point.requests, 0),
    start
  };
}

// src/tui/charts/heatmap.ts
import { truncateToWidth as truncateToWidth8, visibleWidth as visibleWidth6 } from "@oh-my-pi/pi-tui";
var FG_RESET = "\x1B[39m";
var ROW_LABELS = ["M", "T", "W", "T", "F", "S", "S"];
function weeksForWidth(labelWidth, innerWidth) {
  return Math.max(4, Math.min(53, Math.floor((innerWidth - labelWidth) / 2)));
}
function renderHeatmap(points, opts) {
  const weeks = Math.max(1, opts.weeks);
  const layout = calendarLayout(points, weeks, opts.today);
  const selectedDate = opts.selectedDay ? new Date(`${opts.selectedDay}T12:00:00`) : undefined;
  const selectedOffset = selectedDate ? Math.round((Date.UTC(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate()) - Date.UTC(layout.start.getFullYear(), layout.start.getMonth(), layout.start.getDate())) / 86400000) : -1;
  const selectedWeek = Math.floor(selectedOffset / 7);
  const selectedRow = selectedOffset % 7;
  const labelWidth = Math.max(1, Math.floor(opts.labelWidth));
  const columnWidth = 2;
  let monthLine = " ".repeat(labelWidth);
  for (let week = 0;week < weeks; week++) {
    const label = layout.monthLabels[week];
    const targetCol = labelWidth + week * columnWidth;
    if (label && targetCol >= visibleWidth6(monthLine)) {
      monthLine = monthLine.padEnd(targetCol) + label;
    }
  }
  const monthRow = opts.dim(truncateToWidth8(monthLine, opts.innerWidth));
  const body = layout.cells.map((weekRow, dayIndex) => {
    let line = opts.dim(ROW_LABELS[dayIndex] ?? "") + " ".repeat(Math.max(1, labelWidth - 1));
    for (let week = 0;week < weeks; week++) {
      const cell = weekRow[week];
      if (cell === null)
        line += "  ";
      else if (week === selectedWeek && dayIndex === selectedRow && opts.selected) {
        line += `${opts.selected(cell === 0 ? emptyCell(opts.glyphs) : heatCell(opts.glyphs, cell))} `;
      } else if (cell === 0)
        line += `${opts.dim(emptyCell(opts.glyphs))} `;
      else
        line += `${opts.ramp[cell - 1] ?? ""}${heatCell(opts.glyphs, cell)}${FG_RESET} `;
    }
    return line.trimEnd();
  });
  const width = Math.max(0, opts.innerWidth);
  return [monthRow, ...body].map((row) => clampCells(row, width));
}
function ladderRung(set, role, level) {
  const value = set[role];
  if (typeof value === "string")
    return value;
  return value[Math.max(0, Math.min(value.length - 1, level))] ?? value[0];
}
function heatCell(set, level) {
  return ladderRung(set, "heatCell", level - 1);
}
function emptyCell(set) {
  return ladderRung(set, "heatEmpty", 0);
}

// src/tui/features/core/summary.ts
var PROJECT_SORT = {
  folder: (row) => row.folder,
  cost: (row) => row.totalCost,
  requests: (row) => row.totalRequests,
  tokens: (row) => row.conversationTokens,
  cacheRate: (row) => row.cacheRate,
  cacheSavings: (row) => row.cacheSavings,
  errorRate: (row) => row.errorRate,
  duration: (row) => row.avgDuration,
  ttft: (row) => row.avgTtft,
  last: (row) => row.lastTimestamp
};
var REQUEST_SORT = {
  time: (row) => row.timestamp,
  model: (row) => `${row.model} ${row.provider}`,
  project: (row) => row.folder,
  input: (row) => row.usage.input,
  cache: (row) => row.usage.cacheRead,
  output: (row) => row.usage.output,
  cost: (row) => row.usage.cost.total,
  duration: (row) => row.duration,
  ttft: (row) => row.ttft,
  status: requestStatus
};
var DAY_SORT = { day: (row) => row.day, requests: (row) => row.requests, cost: (row) => row.cost, tokens: (row) => row.totalTokens };
function localDay2(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function dayDate(day) {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date);
}
function createSummaryFeature(id, ctx) {
  return new SummaryFeature(id, ctx);
}

class SummaryFeature {
  id;
  ctx;
  range = "24h";
  data = null;
  loading = false;
  error = null;
  generation = 0;
  closed = false;
  focus = 0;
  hideTemporary = true;
  expanded = null;
  chart = new ChartState;
  requests = new ListState((row) => String(row.id ?? `${row.sessionFile}:${row.entryId}`), "time", 12);
  projects = new ListState((row) => row.folder, "cost", 100);
  costRanking = new ListState((row) => row.folder, "cost", 8);
  requestRanking = new ListState((row) => row.folder, "requests", 8);
  days = new ListState((row) => row.day, "day", 30);
  calendarDay = null;
  calendarEnd = null;
  details;
  constructor(id, ctx) {
    this.id = id;
    this.ctx = ctx;
    this.details = new RequestDetails(ctx);
  }
  async load(range) {
    if (this.closed)
      return;
    this.range = range;
    const generation = ++this.generation;
    this.loading = true;
    this.error = null;
    this.ctx.changed();
    try {
      let data;
      let scopedError = null;
      if (this.id === "overview") {
        const [fetched, recent] = await Promise.all([
          this.ctx.reader.fetch(["overview"], range),
          this.ctx.reader.api("/api/stats/recent", { range, limit: "12" }).then((value) => ({ value, error: null }), (cause) => ({
            value: null,
            error: cause instanceof Error ? cause.message : String(cause)
          }))
        ]);
        const overviewData = { ...fetched.data };
        const fetchFailures = Object.values(fetched.errors).filter((message) => typeof message === "string" && message.length > 0);
        const badRecent = recent.value !== null && !Array.isArray(recent.value);
        data = badRecent ? { ...overviewData, recent: [] } : { ...overviewData, ...recent.value === null ? {} : { recent: recent.value } };
        const failures = [...fetchFailures, ...recent.error === null ? [] : [recent.error], ...badRecent ? ["Recent requests payload is not an array"] : []];
        if (failures.length > 0)
          scopedError = failures.join("; ");
      } else {
        const only = await this.ctx.reader.fetch([this.id === "projects" ? "folders" : "dailyActivity"], range);
        data = { ...only.data };
        const failures = Object.values(only.errors).filter((message) => typeof message === "string" && message.length > 0);
        if (failures.length > 0)
          scopedError = failures.join("; ");
      }
      if (this.closed || generation !== this.generation)
        return;
      this.data = data;
      this.error = scopedError;
    } catch (error) {
      if (this.closed || generation !== this.generation)
        return;
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (!this.closed && generation === this.generation) {
        this.loading = false;
        this.ctx.changed();
      }
    }
  }
  overviewChart() {
    const points = this.data?.overview?.timeSeries ?? [];
    const timestamps = points.map((point) => point.timestamp);
    const buckets = bucketAxis(this.range, timestamps, undefined, this.ctx.now());
    this.chart.seedLatestPoint(buckets, timestamps);
    const mode = ["requests", "tokens", "cost"][this.chart.mode % 3];
    const series = mode === "requests" ? [
      { key: "ok", label: "Succeeded", values: densify(points, buckets, (point) => point.requests - point.errors) },
      { key: "err", label: "Failed", values: densify(points, buckets, (point) => point.errors) }
    ] : [{ key: mode, label: mode === "cost" ? "Known-priced API cost" : "Tokens", values: densify(points, buckets, (point) => mode === "cost" ? point.cost : point.tokens) }];
    return {
      buckets,
      series,
      mode,
      unpriced: densify(points, buckets, (point) => point.unpricedRequests ?? 0),
      requests: densify(points, buckets, (point) => point.requests),
      carriesUnpriced: points.some((point) => point.unpricedRequests !== undefined)
    };
  }
  projectRows() {
    const view = buildFolderRows(this.data?.folders ?? []);
    const scoped = this.hideTemporary ? view.rows.filter((row) => !row.temporary) : view.rows;
    const needle = this.projects.search.trim().toLowerCase();
    const matching = this.projects.rows(scoped.filter((row) => !needle || row.folder.toLowerCase().includes(needle)), PROJECT_SORT);
    return { view, scoped, matching };
  }
  selectedDay() {
    const day = this.calendarDay ?? localDay2(new Date(this.ctx.now()));
    return this.data?.dailyActivity?.find((point) => point.day === day) ?? { day, requests: 0, cost: 0, totalTokens: 0 };
  }
  moveCalendar(delta) {
    const today = new Date(this.ctx.now());
    const earliest = localDay2(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 370));
    const date = dayDate(this.selectedDay().day);
    const next = localDay2(new Date(date.getFullYear(), date.getMonth(), date.getDate() + delta));
    this.calendarDay = next < earliest ? earliest : next > localDay2(today) ? localDay2(today) : next;
  }
  render(width, height) {
    const detail = this.details.render(width);
    if (detail)
      return detail;
    if (this.expanded)
      return wrap([this.ctx.theme.bold(this.id === "projects" ? "Project details" : "Day details"), "b/Esc back \xB7 all narrow-table columns below", ...fields(this.expanded)], width);
    const prefix = [
      sectionHeading(this.ctx, width, `${panePrefix(true)}${this.id[0].toUpperCase() + this.id.slice(1)}`, this.id === "activity" ? "371 local days" : this.range, true),
      ...this.loading ? [this.data ? "Refreshing\u2026 existing observations are stale." : "Loading\u2026 no observations yet."] : [],
      ...this.error ? [this.ctx.theme.fg("error", `Read failed: ${this.error}${this.data ? " \xB7 showing stale observations" : ""}`)] : []
    ];
    if (!this.data)
      return wrap(prefix, width);
    if (this.id === "overview") {
      const payload = this.data.overview;
      if (!payload?.overall)
        return wrap([...prefix, "Overview payload unavailable."], width);
      const overall = payload.overall;
      const chart = this.overviewChart();
      const needle = this.requests.search.trim().toLowerCase();
      const rows = this.requests.rows((this.data.recent ?? []).filter((row) => !needle || `${row.model} ${row.provider} ${row.folder}`.toLowerCase().includes(needle)), REQUEST_SORT);
      const columns = [
        { key: "model", header: "Model", align: "left", value: (row) => row.model },
        { key: "provider", header: "Provider", align: "left", priority: 5, value: (row) => row.provider },
        { key: "when", header: "When", align: "left", priority: 3, value: (row) => formatTimestamp(row.timestamp) },
        { key: "status", header: "Status", align: "left", priority: 4, value: requestStatus },
        { key: "cost", header: "API cost", align: "right", priority: 0, value: (row) => formatMessageCost(row, 4) },
        { key: "tokens", header: "Tokens", align: "right", priority: 1, value: (row) => formatCompact(row.usage.totalTokens) },
        { key: "duration", header: "Latency", align: "right", priority: 2, value: (row) => formatDurationMs(row.duration) }
      ];
      const total = sumConversationTokens(overall);
      const mix = [["Uncached input", overall.totalInputTokens], ["Cache read", overall.totalCacheReadTokens], ["Cache write", overall.totalCacheWriteTokens], ["Output", overall.totalOutputTokens]];
      const agents = buildAgentTokenShare(payload.byAgentType);
      const prefixLines = wrap(prefix, width);
      const metrics = metricRail(this.ctx, width, [
        { label: "Requests", value: formatCompact(overall.totalRequests), hint: `${formatCompact(overall.successfulRequests)} succeeded`, emphasis: "primary" },
        { label: "API cost", value: formatEstimatedCost(overall.totalCost, overall.unpricedRequests), hint: `${overall.unpricedRequests} unpriced` },
        { label: "Tokens", value: formatCompact(total), hint: `${formatCompact(overall.totalPremiumRequests)} premium req` },
        { label: "Cache hit", value: formatPercent(overall.cacheRate), hint: cacheSavingsNote(overall.cacheSavings) },
        { label: "Latency", value: formatDurationMs(overall.avgDuration), hint: `${formatDurationMs(overall.avgTtft)} TTFT` },
        { label: "Failures", value: formatCompact(overall.failedRequests), hint: `${formatPercent(overall.errorRate)} error rate` }
      ], { maxRows: 2 });
      const tabs = focusTabs(this.ctx, width, ["Requests", "Chart"], this.focus);
      const tokenMix = dataTable(this.ctx, width, "Token mix", [
        { key: "label", header: "Category", align: "left" },
        { key: "tokens", header: "Tokens", align: "right", priority: 0 },
        { key: "share", header: "Share", align: "right", priority: 1 }
      ], mix.map(([label, value]) => ({ label, tokens: formatCompact(value), share: total > 0 ? formatPercent(value / total) : "\u2014" })));
      const agentShares = dataTable(this.ctx, width, "Agent token shares", [
        { key: "agent", header: "Agent", align: "left" },
        { key: "tokens", header: "Tokens", align: "right", priority: 0 },
        { key: "share", header: "Share", align: "right", priority: 1 },
        { key: "requests", header: "Req", align: "right", priority: 2 }
      ], agents.segments.map((agent) => ({ agent: agent.agentType, tokens: formatCompact(agent.tokens), share: formatPercent(agent.share), requests: String(agent.requests) })));
      const notice = chart.mode === "cost" && overall.unpricedRequests > 0 ? wrap([this.ctx.theme.fg("dim", `Known-priced cost only \xB7 ${overall.unpricedRequests} unpriced requests; per-bucket unknown counts unavailable.`)], width) : [];
      const cue = wrap([this.ctx.theme.fg("dim", this.focus === 0 ? this.requests.editing || this.requests.search ? "Keys: search \xB7 Enter/Esc finish \xB7 Ctrl-U clear \xB7 Tab pane" : "Keys: / search \xB7 j/k select \xB7 Enter details \xB7 o/O sort \xB7 A all \xB7 Tab pane" : "Keys: m mode \xB7 n legend \xB7 v visibility \xB7 ,/. point \xB7 Tab pane")], width);
      const base = prefixLines.length + metrics.length + 1 + tabs.length + cue.length + 1;
      const primaryBudget = Math.max(12, Math.min(18, height - base));
      const chartOverhead = 3 + notice.length + chart.series.length;
      const wide = width >= 80;
      const leftWidth = Math.floor((width - 2) / 2);
      const rightWidth = width - 2 - leftWidth;
      const listWidth = wide ? this.focus === 0 ? leftWidth : rightWidth : width;
      const graphWidth = wide ? this.focus === 0 ? rightWidth : leftWidth : width;
      const listHeight = wide ? primaryBudget : Math.max(6, Math.min(8, primaryBudget - 1 - 5 - chartOverhead));
      const chartHeight = Math.max(5, (wide ? primaryBudget : primaryBudget - 1 - listHeight) - chartOverhead);
      const list = this.requests.render(rows, listWidth, listHeight, columns, this.ctx, `${panePrefix(this.focus === 0)}Latest requests \xB7 A opens all`, { showHint: false });
      const graph = [
        paneHeading(this.ctx, graphWidth, "Activity", chart.mode, this.focus === 1),
        ...notice,
        ...this.chart.render(this.ctx, graphWidth, chart.buckets, chart.series, {
          height: chartHeight,
          unit: chart.mode === "cost" ? "API-equivalent USD / bucket" : chart.mode === "tokens" ? "tokens / bucket" : "requests / bucket",
          stacked: true,
          format: chart.mode === "cost" ? formatCost : formatCompact,
          formatValue: chart.mode === "cost" ? (key, value, point) => {
            const unpriced = chart.unpriced[point] ?? 0;
            const unknown = unpriced > 0 ? unpriced : !chart.carriesUnpriced && (chart.requests[point] ?? 0) > 0 ? 1 : 0;
            return formatEstimatedCost(value ?? 0, unknown);
          } : undefined,
          showHint: false
        })
      ];
      let pair;
      let listOffset = base;
      let colShift = 0;
      if (wide) {
        const listFirst = this.focus === 0;
        if (!listFirst)
          colShift = leftWidth + 2;
        pair = [...sideBySide(this.ctx, width, listFirst ? list : graph, listFirst ? graph : list)];
      } else {
        pair = this.focus === 0 ? [...list, "", ...graph] : [...graph, "", ...list];
        listOffset += this.focus === 0 ? 0 : graph.length + 1;
      }
      this.ctx.reportHits?.(this.requests.lastHits.map((hit) => ({
        ...hit,
        rowStart: hit.rowStart + listOffset,
        rowEnd: hit.rowEnd + listOffset,
        colStart: hit.colStart + colShift,
        colEnd: hit.colEnd + colShift
      })));
      return [...prefixLines, ...metrics, "", ...tabs, ...cue, "", ...pair, "", ...tokenMix, "", ...agentShares];
    }
    if (this.id === "projects") {
      const { view, scoped, matching } = this.projectRows();
      const cost = this.costRanking.rows(scoped, PROJECT_SORT).slice(0, 8);
      const requests = this.requestRanking.rows(scoped, PROJECT_SORT).slice(0, 8);
      const columns = [
        { key: "folder", header: "Project", align: "left", value: (row) => `${row.folder || "(root)"}${row.temporary ? " [temp]" : ""}` },
        { key: "cost", header: "API cost", align: "right", priority: 0, value: (row) => formatEstimatedCost(row.totalCost, row.unpricedRequests) },
        { key: "requests", header: "Req", align: "right", priority: 1, value: (row) => formatCompact(row.totalRequests) },
        { key: "tokens", header: "Tokens", align: "right", priority: 2, value: (row) => formatCompact(row.conversationTokens) },
        { key: "errors", header: "Error", align: "right", priority: 3, value: (row) => formatPercent(row.errorRate) },
        { key: "cache", header: "Cache", align: "right", priority: 4, value: (row) => formatPercent(row.cacheRate) }
      ];
      const lists = [this.projects, this.costRanking, this.requestRanking];
      const rowSets = [matching, cost, requests];
      const titles = ["Projects", "Cost ranking \xB7 Enter filters projects", "Request ranking \xB7 Enter filters projects"];
      const prefixLines = wrap(prefix, width);
      const metrics = metricGrid(this.ctx, width, [
        { label: "Projects", value: String(view.rows.length), hint: `${view.temporaryCount} temporary`, emphasis: "primary" },
        { label: "Requests", value: formatCompact(view.totalRequests), hint: `${view.failedRequests} failed` },
        { label: "API cost", value: formatEstimatedCost(view.totalCost, view.unpricedRequests), hint: `${view.unpricedRequests} unpriced` },
        { label: "Tokens", value: formatCompact(view.conversationTokens), hint: `${formatPercent(view.cacheRate)} cache hit` }
      ]);
      const dimLine = wrap([this.ctx.theme.fg("dim", `Totals include all projects \xB7 t ${this.hideTemporary ? "show" : "hide"} temporary projects${this.hideTemporary && view.temporaryCount ? ` (${view.temporaryCount} hidden)` : ""}`)], width);
      const tabs = focusTabs(this.ctx, width, ["Projects", "By cost", "By requests"], this.focus);
      const cue = wrap([this.ctx.theme.fg("dim", this.focus === 0 && (this.projects.editing || this.projects.search) ? "Keys: search \xB7 Enter/Esc finish \xB7 Ctrl-U clear \xB7 Tab pane" : "Keys: j/k select \xB7 Enter details/filter \xB7 o/O sort \xB7 t temporary \xB7 / search \xB7 Tab pane")], width);
      const listOffset = prefixLines.length + metrics.length + dimLine.length + 1 + tabs.length + cue.length + 1;
      const list = lists[this.focus].render(rowSets[this.focus], width, Math.max(5, height - listOffset), columns, this.ctx, `${panePrefix(true)}${titles[this.focus]}`, { showHint: false });
      this.ctx.reportHits?.(lists[this.focus].lastHits.map((hit) => ({
        ...hit,
        rowStart: hit.rowStart + listOffset,
        rowEnd: hit.rowEnd + listOffset
      })));
      return [...prefixLines, ...metrics, ...dimLine, "", ...tabs, ...cue, "", ...list];
    }
    const points = this.data.dailyActivity ?? [];
    const weeks = weeksForWidth(2, width);
    const actualToday = new Date(this.ctx.now());
    const selected = this.selectedDay();
    let today = this.calendarEnd ? dayDate(this.calendarEnd) : actualToday;
    const visibleStart = localDay2(calendarLayout(points, weeks, today).start);
    if (selected.day < visibleStart || selected.day > localDay2(today)) {
      const date = dayDate(selected.day);
      const end = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 6 - (date.getDay() + 6) % 7);
      today = end > actualToday ? actualToday : end;
      this.calendarEnd = localDay2(today);
    }
    const layout = calendarLayout(points, weeks, today);
    const windowUnpriced = points.filter((point) => point.day >= localDay2(layout.start) && point.day <= localDay2(today)).reduce((sum, point) => sum + (point.unpricedRequests ?? 0), 0);
    const needle = this.days.search.trim().toLowerCase();
    const rows = this.days.rows(points.filter((point) => !needle || point.day.includes(needle)), DAY_SORT);
    const calendar = [
      paneHeading(this.ctx, width, "Activity calendar", `${weeks} weeks`, this.focus === 1),
      ...renderHeatmap(points, { innerWidth: width, labelWidth: 2, weeks, glyphs: glyphsFor(this.ctx.theme.getSymbolPreset()), ramp: [0, 1, 2, 3].map((level) => heatRamp(this.ctx.theme, level)), dim: (text) => this.ctx.theme.fg("dim", text), today, selectedDay: selected.day, selected: (text) => this.ctx.theme.bg(SELECTION_BG.band, this.ctx.theme.fg("accent", text)) }),
      ...wrap([
        this.ctx.theme.fg("dim", `${localDay2(layout.start)}\u2013${localDay2(today)} \xB7 ${layout.totalRequests} requests \xB7 ${formatEstimatedCost(layout.totalCost, windowUnpriced)}`),
        this.ctx.theme.fg("dim", "j/k day \xB7 h/l week \xB7 t today \xB7 Enter details")
      ], width)
    ];
    const prefixLines = wrap(prefix, width);
    const metrics = metricGrid(this.ctx, width, [
      { label: "Day requests", value: formatCompact(selected.requests), hint: selected.day, emphasis: "primary" },
      { label: "Day API cost", value: formatEstimatedCost(selected.cost, selected.unpricedRequests ?? 0), hint: "selected local day" },
      { label: "Day tokens", value: formatCompact(selected.totalTokens), hint: `${points.length} recorded days` }
    ]);
    const tabs = focusTabs(this.ctx, width, ["Recorded days", "Calendar"], this.focus);
    const cue = wrap([this.ctx.theme.fg("dim", this.focus === 0 ? this.days.editing || this.days.search ? "Keys: search \xB7 Enter/Esc finish \xB7 Ctrl-U clear \xB7 Tab pane" : "Keys: j/k select \xB7 Enter details \xB7 o/O sort \xB7 / search \xB7 Tab pane" : "Keys: j/k day \xB7 h/l week \xB7 t today \xB7 Enter details \xB7 Tab pane")], width);
    const tail = wrap([this.ctx.theme.fg("dim", "Latest 371 local days \xB7 independent of the range selector; quiet selected days are zero.")], width);
    const beforePane = prefixLines.length + metrics.length + 1 + tabs.length + cue.length + 1;
    const used = beforePane + calendar.length + 1 + tail.length;
    const list = this.days.render(rows, width, Math.max(5, height - used), [
      { key: "day", header: "Day", align: "left", value: (point) => point.day },
      { key: "requests", header: "Req", align: "right", priority: 0, value: (point) => formatCompact(point.requests) },
      { key: "cost", header: "API cost", align: "right", priority: 1, value: (point) => formatEstimatedCost(point.cost, point.unpricedRequests ?? 0) },
      { key: "tokens", header: "Tokens", align: "right", priority: 2, value: (point) => formatCompact(point.totalTokens) }
    ], this.ctx, `${panePrefix(this.focus === 0)}Recorded days`, { showHint: false });
    const leading = this.focus === 0 ? list : calendar;
    const trailing = this.focus === 0 ? calendar : list;
    const calendarOffset = beforePane + (this.focus === 0 ? list.length + 1 : 0);
    const listOffset = beforePane + (this.focus === 0 ? 0 : calendar.length + 1);
    this.ctx.reportHits?.(this.days.lastHits.map((hit) => ({
      ...hit,
      rowStart: hit.rowStart + listOffset,
      rowEnd: hit.rowEnd + listOffset
    })));
    const hits = [];
    for (let dayIndex = 0;dayIndex < 7; dayIndex++) {
      for (let week = 0;week < weeks; week++) {
        if (layout.cells[dayIndex][week] === null)
          continue;
        const date = new Date(layout.start.getFullYear(), layout.start.getMonth(), layout.start.getDate() + week * 7 + dayIndex);
        hits.push({
          rowStart: calendarOffset + 2 + dayIndex,
          rowEnd: calendarOffset + 3 + dayIndex,
          colStart: 2 + week * 2,
          colEnd: 2 + week * 2 + 2,
          action: { type: "selectDay", day: localDay2(date) }
        });
      }
    }
    this.ctx.reportHits?.(hits);
    return [...prefixLines, ...metrics, "", ...tabs, ...cue, "", ...leading, "", ...trailing, ...tail];
  }
  get inputMode() {
    return (this.id === "overview" ? this.requests.editing : this.id === "projects" ? this.projects.editing : this.days.editing) ? "text" : "navigation";
  }
  handleInput(data) {
    if (this.closed || data === "q" && this.inputMode !== "text")
      return false;
    if (this.details.active)
      return this.details.handleInput(data);
    if (this.expanded) {
      if (data === "b" || data === "\x1B") {
        this.expanded = null;
        this.ctx.changed();
        return true;
      }
      return false;
    }
    let handled = false;
    if (this.id === "overview") {
      const needle = this.requests.search.trim().toLowerCase();
      const rows = this.requests.rows((this.data?.recent ?? []).filter((row) => !needle || `${row.model} ${row.provider} ${row.folder}`.toLowerCase().includes(needle)), REQUEST_SORT);
      if (this.requests.editing)
        handled = this.requests.input(data, rows);
      else if (data === "A") {
        this.ctx.openScreen("requests");
        handled = true;
      } else if (data === "\t") {
        this.focus = (this.focus + 1) % 2;
        handled = true;
      } else if (this.focus === 1 && data === "m") {
        this.chart.mode = (this.chart.mode + 1) % 3;
        handled = true;
      } else if (this.focus === 1)
        handled = this.chart.input(data, this.overviewChart().series.map((series) => series.key));
      else if (data === "\r" || data === `
`) {
        const row = this.requests.current(rows);
        if (row)
          this.details.open(row);
        handled = true;
      } else if (data === "o" || data === "O") {
        if (data === "O")
          this.requests.descending = !this.requests.descending;
        else {
          const sorts = Object.keys(REQUEST_SORT);
          this.requests.sort = sorts[(sorts.indexOf(this.requests.sort) + 1) % sorts.length];
        }
        handled = true;
      } else
        handled = this.requests.input(data, rows);
    } else if (this.id === "projects") {
      const { scoped, matching } = this.projectRows();
      const list = [this.projects, this.costRanking, this.requestRanking][this.focus];
      const rows = this.focus === 0 ? matching : list.rows(scoped, PROJECT_SORT).slice(0, 8);
      if (this.projects.editing)
        handled = this.projects.input(data, matching);
      else if (data === "\t") {
        this.focus = (this.focus + 1) % 3;
        handled = true;
      } else if (data === "t") {
        this.hideTemporary = !this.hideTemporary;
        handled = true;
      } else if (data === "/") {
        this.focus = 0;
        handled = this.projects.input(data, matching);
      } else if (data === "\r" || data === `
`) {
        const row = list.current(rows);
        if (row) {
          if (this.focus === 0)
            this.expanded = row;
          else {
            this.projects.search = row.folder;
            this.projects.selected = row.folder;
            this.focus = 0;
          }
        }
        handled = true;
      } else if (data === "o" || data === "O") {
        if (data === "O")
          list.descending = !list.descending;
        else {
          const sorts = Object.keys(PROJECT_SORT);
          list.sort = sorts[(sorts.indexOf(list.sort) + 1) % sorts.length];
        }
        handled = true;
      } else if (data === "\x1B" && this.projects.search) {
        this.projects.search = "";
        handled = true;
      } else
        handled = list.input(data, rows);
    } else {
      const points = this.data?.dailyActivity ?? [];
      const rows = this.days.rows(points.filter((point) => !this.days.search || point.day.includes(this.days.search.trim())), DAY_SORT);
      if (this.days.editing)
        handled = this.days.input(data, rows);
      else if (data === "\t") {
        this.focus = (this.focus + 1) % 2;
        handled = true;
      } else if (data === "/") {
        this.focus = 0;
        handled = this.days.input(data, rows);
      } else if (this.focus === 0 && (data === "\r" || data === `
`)) {
        this.expanded = this.days.current(rows) ?? null;
        handled = true;
      } else if (this.focus === 1 && (data === "j" || data === "k" || data === "\x1B[B" || data === "\x1B[A" || data === "h" || data === "l")) {
        this.moveCalendar(data === "h" ? -7 : data === "l" ? 7 : data === "k" || data === "\x1B[A" ? -1 : 1);
        handled = true;
      } else if (this.focus === 1 && data === "t") {
        this.calendarDay = localDay2(new Date(this.ctx.now()));
        this.calendarEnd = null;
        handled = true;
      } else if (this.focus === 1 && (data === "\r" || data === `
`)) {
        this.expanded = this.selectedDay();
        handled = true;
      } else if (this.focus === 0 && (data === "o" || data === "O")) {
        if (data === "O")
          this.days.descending = !this.days.descending;
        else {
          const sorts = Object.keys(DAY_SORT);
          this.days.sort = sorts[(sorts.indexOf(this.days.sort) + 1) % sorts.length];
        }
        handled = true;
      } else if (this.focus === 0)
        handled = this.days.input(data, rows);
    }
    if (handled)
      this.ctx.changed();
    return handled;
  }
  handleHit(action) {
    if (action.type === "selectRow") {
      if (this.id === "overview")
        this.requests.selected = action.key;
      else if (this.id === "projects") {
        const list = [this.projects, this.costRanking, this.requestRanking][this.focus];
        if (list)
          list.selected = action.key;
      } else
        this.days.selected = action.key;
    } else if (action.type === "selectDay") {
      this.calendarDay = action.day;
      this.calendarEnd = null;
    }
    this.ctx.changed();
  }
  dispose() {
    this.closed = true;
    this.generation++;
    this.details.dispose();
  }
}

// src/tui/features/core.ts
function createCoreFeature(id, ctx) {
  switch (id) {
    case "requests":
    case "errors":
      return createRequestsFeature(id, ctx);
    case "models":
    case "costs":
    case "tools":
      return createAnalyticsFeature(id, ctx);
    case "overview":
    case "projects":
    case "activity":
      return createSummaryFeature(id, ctx);
    default:
      return null;
  }
}

// src/tui/features/providers.ts
import { wrapTextWithAnsi as wrapTextWithAnsi4 } from "@oh-my-pi/pi-tui";

// src/tui/features/provider-gain-data.ts
var DAY = 86400000;
var HOUR = 3600000;
function rangeStep(range) {
  return rangeMeta(range).bucketMs;
}
function rangeAxis(range, timestamps, now, step = rangeStep(range)) {
  return bucketAxis(range, timestamps, step, now);
}
function resolveWindow(insights, picked) {
  if (picked && insights.some((i) => i.provider === picked.provider && i.windowKey === picked.windowKey))
    return picked;
  const fallback = picked && insights.find((i) => i.provider === picked.provider) || insights.reduce((best, i) => !best || i.fractionConsumed > best.fractionConsumed ? i : best, undefined);
  return fallback ? { provider: fallback.provider, windowKey: fallback.windowKey } : null;
}
function accountNames(series) {
  const groups = new Map;
  for (const s of series) {
    const keys = groups.get(s.accountLabel) ?? new Set;
    keys.add(s.accountKey);
    groups.set(s.accountLabel, keys);
  }
  const names = new Map;
  for (const [label, keys] of groups)
    [...keys].sort().forEach((key, i) => names.set(key, keys.size > 1 ? `${label} #${i + 1}` : label));
  return names;
}
function accountReadings(series) {
  let latest = null;
  let peak = null;
  let resets = 0;
  let previous = null;
  for (const p of [...series.points].sort((a, b) => a.timestamp - b.timestamp)) {
    if (p.usedFraction === null)
      continue;
    if (previous !== null && p.usedFraction - previous < -0.05)
      resets++;
    previous = p.usedFraction;
    peak = Math.max(peak ?? 0, p.usedFraction);
    latest = { fraction: p.usedFraction, timestamp: p.timestamp, exhausted: p.exhausted };
  }
  return { latest, peak, resets, samples: series.points.length };
}
function utilization(series) {
  let first = Infinity;
  let last = -Infinity;
  for (const s of series)
    for (const p of s.points) {
      first = Math.min(first, p.timestamp);
      last = Math.max(last, p.timestamp);
    }
  if (last < first)
    return { axis: [], step: HOUR, rows: [], exhausted: [] };
  const step = [300000, 900000, 1800000, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY].find((v) => (last - first) / v < 240) ?? DAY;
  const axis = rangeAxis("all", [first], last, step);
  const exhausted = axis.map(() => []);
  const rows = series.map((s) => {
    const values = axis.map(() => null);
    const readAt = axis.map(() => -Infinity);
    for (const p of s.points) {
      const i = Math.floor((p.timestamp - axis[0]) / step);
      if (i < 0 || i >= axis.length)
        continue;
      if (p.exhausted && !exhausted[i].includes(s.accountKey))
        exhausted[i].push(s.accountKey);
      if (p.usedFraction === null || p.timestamp < readAt[i])
        continue;
      values[i] = p.usedFraction;
      readAt[i] = p.timestamp;
    }
    let held = null;
    let heldAt = 0;
    for (let i = 0;i < axis.length; i++) {
      if (values[i] !== null) {
        held = values[i];
        heldAt = readAt[i];
      } else if (held !== null && axis[i] - heldAt <= 6 * HOUR)
        values[i] = held;
    }
    return { key: s.accountKey, values };
  });
  return { axis, step, rows, exhausted };
}
function projectOptions(projects, selected) {
  return [null, ...new Set(selected !== null && !projects.includes(selected) ? [selected, ...projects] : projects)];
}
function savingsHistory(points, range, now) {
  const timestamped = points.map((p) => ({ ...p, timestamp: Date.parse(`${p.date}T00:00:00Z`) }));
  const axis = rangeAxis(range, timestamped.map((p) => p.timestamp), now, DAY);
  const daily = densify(timestamped, axis, (p) => p.snapcompact);
  let total = 0;
  return { axis, daily, cumulative: daily.map((v) => total += v) };
}

// src/tui/features/provider-gain-chart.ts
import { truncateToWidth as truncateToWidth9, visibleWidth as visibleWidth7 } from "@oh-my-pi/pi-tui";
function recordViewport(rows, selected, height, reveal, reserve = 13) {
  const count = Math.max(1, Math.min(reveal, Math.max(3, height - reserve)));
  const start = Math.max(0, Math.min(rows.length - count, selected - Math.floor(count / 2)));
  return { rows: rows.slice(start, start + count), start };
}
function boundLines(lines, width) {
  return lines.map((line) => visibleWidth7(line) > width ? truncateToWidth9(line, Math.max(0, width)) : line);
}

// src/tui/features/providers.ts
var VIEWS = ["Provider totals", "Burn by provider", "Peak local hours", "Subscription windows", "Account utilization"];
var METRICS = ["tokens", "output", "requests", "cost"];
var TOTAL_SORTS = ["tokens", "provider", "requests", "errors", "models", "request share", "output", "cost", "premium", "speed"];
var WINDOW_SORTS = ["consumed", "window", "accounts", "cycles", "capacity", "peak", "ideal", "exhausted"];
var ACCOUNT_SORTS = ["latest", "account", "window", "status", "peak", "samples", "recorded", "resets"];
function createProvidersFeature(ctx) {
  let range = "24h";
  let data = null;
  let insights = null;
  let accountData = null;
  let picked = null;
  let accountProvider = null;
  let localGeneration = 0;
  let windowsGeneration = 0;
  let accountsGeneration = 0;
  let closed = false;
  let localLoading = false;
  let windowsLoading = false;
  let accountsLoading = false;
  let localError = null;
  let windowsError = null;
  let accountsError = null;
  let view = 0;
  let row = 0;
  let providerRow = 0;
  let selectedProvider = null;
  let expanded = null;
  let metric = 0;
  let point = -1;
  let utilPoint = -1;
  let hour = 0;
  let peakProvider = null;
  let legend = 0;
  let totalSort = 0;
  let windowSort = 0;
  let accountSort = 0;
  let descending = true;
  let selectedAccount = null;
  const hiddenBurn = new Set;
  const hiddenAccounts = new Set;
  function sortedTotals() {
    const key = TOTAL_SORTS[totalSort];
    const providers = [...data?.providers ?? []];
    const totalRequests = providers.reduce((sum, p) => sum + p.totalRequests, 0);
    const value = (p) => key === "provider" ? p.provider : key === "requests" ? p.totalRequests : key === "errors" ? p.totalRequests > 0 ? p.failedRequests / p.totalRequests : 0 : key === "models" ? p.models : key === "request share" ? totalRequests > 0 ? p.totalRequests / totalRequests : 0 : key === "output" ? p.totalOutputTokens : key === "cost" ? p.totalCost : key === "premium" ? p.totalPremiumRequests : key === "speed" ? p.avgTokensPerSecond ?? -1 : p.totalTokens;
    return providers.sort((a, b) => {
      const av = value(a), bv = value(b);
      return (typeof av === "string" && typeof bv === "string" ? av.localeCompare(bv) : Number(av) - Number(bv)) * (descending ? -1 : 1);
    });
  }
  function sortedWindows() {
    const key = WINDOW_SORTS[windowSort];
    const value = (i) => key === "window" ? `${i.provider} ${i.windowLabel}` : key === "accounts" ? i.accounts : key === "cycles" ? i.cycles : key === "capacity" ? i.estTokensPerWindow ?? -1 : key === "peak" ? i.peakConcurrentFraction : key === "ideal" ? i.idealAccounts - i.accounts : key === "exhausted" ? i.exhaustedEvents : i.fractionConsumed;
    return [...insights ?? []].sort((a, b) => {
      const av = value(a), bv = value(b);
      return (typeof av === "string" && typeof bv === "string" ? av.localeCompare(bv) : Number(av) - Number(bv)) * (descending ? -1 : 1);
    });
  }
  function accountRows() {
    const series = (accountData?.usageSeries ?? []).filter((s) => s.provider === picked?.provider && accountProvider === picked?.provider);
    const names = accountNames(series);
    const key = ACCOUNT_SORTS[accountSort];
    const value = (r) => key === "account" ? r.name : key === "window" ? r.series.windowLabel : key === "status" ? r.latest?.exhausted ? 2 : (r.latest?.fraction ?? 0) >= 0.8 ? 1 : 0 : key === "peak" ? r.peak ?? -1 : key === "samples" ? r.samples : key === "recorded" ? r.latest?.timestamp ?? 0 : key === "resets" ? r.resets : r.latest?.fraction ?? -1;
    return series.map((s) => ({ ...accountReadings(s), series: s, name: names.get(s.accountKey) ?? s.accountLabel })).sort((a, b) => {
      const av = value(a), bv = value(b);
      return (typeof av === "string" && typeof bv === "string" ? av.localeCompare(bv) : Number(av) - Number(bv)) * (descending ? -1 : 1);
    });
  }
  function burn() {
    const axis = rangeAxis(range, (data?.series ?? []).map((p) => p.timestamp), ctx.now());
    const step = rangeStep(range);
    const metricName = METRICS[metric];
    const value = (p) => metricName === "tokens" ? p.totalTokens : metricName === "requests" ? p.requests : metricName === "cost" ? p.cost : p.outputTokens ?? null;
    const points = (data?.series ?? []).filter((p) => value(p) !== null);
    const unpriced = new Map;
    for (const p of points) {
      const bucket = axis.indexOf(p.timestamp);
      if (bucket < 0)
        continue;
      const key = `provider:${p.provider}`;
      const counts = unpriced.get(key) ?? Array.from({ length: axis.length }, () => 0);
      counts[bucket] += p.unpricedRequests ?? 0;
      unpriced.set(key, counts);
    }
    const rows = pivotSeries(points, {
      buckets: axis,
      key: (p) => `provider:${p.provider}`,
      label: (key) => key.slice("provider:".length),
      value: (p) => value(p),
      limit: 6
    }).map((s) => ({ key: s.key, label: s.label, values: s.values.map((v) => v || null) }));
    return { axis, rows, step, metricName, unpriced };
  }
  async function loadAccounts(provider) {
    const request = ++accountsGeneration;
    const requestedRange = range;
    if (accountProvider !== provider) {
      accountData = null;
      selectedAccount = null;
      row = 0;
    }
    accountProvider = provider;
    accountsLoading = true;
    accountsError = null;
    ctx.changed();
    try {
      const next = await ctx.reader.api("/api/stats/provider-windows", { range: requestedRange, provider });
      if (closed || request !== accountsGeneration || picked?.provider !== provider || range !== requestedRange)
        return;
      if (!next || !Array.isArray(next.usageSeries)) {
        accountsError = "Account payload missing usageSeries";
        return;
      }
      accountData = next;
      const rows = accountRows();
      const retained = rows.findIndex((r) => JSON.stringify([r.series.windowKey, r.series.accountKey]) === selectedAccount);
      row = retained >= 0 ? retained : Math.max(0, rows.findIndex((r) => r.series.windowKey === picked?.windowKey));
      utilPoint = -1;
    } catch (cause) {
      if (closed || request !== accountsGeneration)
        return;
      accountsError = cause instanceof Error ? cause.message : String(cause);
    } finally {
      if (!closed && request === accountsGeneration) {
        accountsLoading = false;
        ctx.changed();
      }
    }
  }
  function selectWindow(next) {
    const changedProvider = next.provider !== picked?.provider;
    picked = next;
    utilPoint = -1;
    if (changedProvider || accountProvider !== next.provider || !accountData && !accountsLoading)
      loadAccounts(next.provider);
  }
  async function loadWindows() {
    const request = ++windowsGeneration;
    const requestedRange = range;
    const accountRequest = accountsGeneration;
    windowsLoading = true;
    windowsError = null;
    ctx.changed();
    try {
      const next = await ctx.reader.api("/api/stats/provider-windows", { range: requestedRange });
      if (closed || request !== windowsGeneration || range !== requestedRange)
        return;
      if (!next || !Array.isArray(next.windowInsights)) {
        windowsError = "Subscription window payload missing windowInsights";
        return;
      }
      insights = next.windowInsights;
      const resolved = resolveWindow(insights, picked);
      if (resolved) {
        selectWindow(resolved);
        if (accountsGeneration === accountRequest && !accountsLoading)
          loadAccounts(resolved.provider);
      } else {
        picked = null;
        accountData = null;
        accountProvider = null;
        accountsGeneration++;
        accountsLoading = false;
      }
    } catch (cause) {
      if (closed || request !== windowsGeneration)
        return;
      windowsError = cause instanceof Error ? cause.message : String(cause);
    } finally {
      if (!closed && request === windowsGeneration) {
        windowsLoading = false;
        ctx.changed();
      }
    }
  }
  async function load(nextRange) {
    if (closed)
      return;
    if (range !== nextRange) {
      data = null;
      insights = null;
      accountData = null;
      accountsGeneration++;
      accountsLoading = false;
      point = -1;
      utilPoint = -1;
    }
    range = nextRange;
    const request = ++localGeneration;
    localLoading = true;
    localError = null;
    try {
      const localRead = ctx.reader.api("/api/stats/providers", { range });
      const next = await localRead;
      if (closed || request !== localGeneration)
        return;
      if (!next || !Array.isArray(next.providers) || !Array.isArray(next.series) || !Array.isArray(next.hourly)) {
        localError = "Providers payload missing providers/series/hourly";
        return;
      }
      data = next;
      const axis = rangeAxis(range, next.series.map((p) => p.timestamp), ctx.now());
      point = point < 0 ? axis.length - 1 : Math.min(point, axis.length - 1);
      if (peakProvider && !next.providers.some((p) => p.provider === peakProvider))
        peakProvider = null;
      providerRow = Math.min(providerRow, Math.max(0, next.providers.length - 1));
    } catch (cause) {
      if (closed || request !== localGeneration)
        return;
      localError = cause instanceof Error ? cause.message : String(cause);
    } finally {
      if (!closed && request === localGeneration) {
        localLoading = false;
        ctx.changed();
      }
    }
    if (!closed && view >= 3)
      loadWindows();
  }
  return {
    load,
    render(width, height) {
      const preset = ctx.theme.getSymbolPreset();
      const lines = [ctx.theme.bold(`Providers \xB7 ${range}`)];
      if (localError)
        lines.push(ctx.theme.fg("error", `Local usage: ${localError}`));
      if (windowsError)
        lines.push(ctx.theme.fg("warning", `Subscription snapshots: ${windowsError} (local usage remains available)`));
      if (accountsError && view === 4)
        lines.push(ctx.theme.fg("warning", `Account snapshots: ${accountsError}`));
      if (data) {
        const totals = data.providers.reduce((t, p) => ({ tokens: t.tokens + p.totalTokens, requests: t.requests + p.totalRequests, failed: t.failed + p.failedRequests, cost: t.cost + p.totalCost, unpriced: t.unpriced + p.unpricedRequests }), { tokens: 0, requests: 0, failed: 0, cost: 0, unpriced: 0 });
        const axis = rangeAxis(range, data.series.map((p) => p.timestamp), ctx.now());
        lines.push(...metricGrid(ctx, width, [
          { label: "Tokens", value: compactTokens(totals.tokens), emphasis: "primary", hint: `${data.providers.length} providers`, spark: densify(data.series, axis, (p) => p.totalTokens) },
          { label: "Requests", value: formatInteger2(totals.requests), hint: `${formatPercent2(totals.requests > 0 ? totals.failed / totals.requests : 0)} errors` },
          { label: "API-equivalent", value: costWithUnpriced(totals.cost, totals.unpriced), hint: "Public API rates" }
        ]));
      }
      lines.push(...focusTabs(ctx, width, ["Totals", "Burn", "Local hours", "Windows", "Accounts"], view));
      const hint = view === 0 ? "j/k provider \xB7 Enter mix \xB7 o sort \xB7 d direction" : view === 1 ? "m metric \xB7 h/l point \xB7 n/N legend \xB7 Space hide" : view === 2 ? "h/l hour \xB7 p/P provider" : view === 3 ? "j/k window \xB7 Enter accounts \xB7 o sort \xB7 u retry" : "j/k account \xB7 h/l point \xB7 p/P provider \xB7 w/W window \xB7 n/N legend \xB7 Space hide";
      lines.push(...wrapTextWithAnsi4(ctx.theme.fg("dim", `Tab view \xB7 ${hint}`), width));
      if (localLoading || windowsLoading || accountsLoading)
        lines.push(ctx.theme.fg("dim", `Loading ${[localLoading ? "usage" : "", windowsLoading ? "windows" : "", accountsLoading ? "accounts" : ""].filter(Boolean).join(" \xB7 ")} independently`));
      if (view <= 2 && !data) {
        lines.push(localLoading ? "Loading local usage\u2026" : "No local usage payload available");
        return boundLines(lines, width);
      }
      if (view === 0) {
        const rows = sortedTotals();
        const retained = rows.findIndex((p) => p.provider === selectedProvider);
        providerRow = retained >= 0 ? retained : Math.max(0, Math.min(providerRow, rows.length - 1));
        const p = rows[providerRow];
        lines.push(sectionHeading(ctx, width, "Provider totals", `${TOTAL_SORTS[totalSort]} ${descending ? "\u2193" : "\u2191"} \xB7 ${rows.length} providers`, true));
        const expandedBlock = [];
        if (p && expanded === p.provider) {
          const mix = [["Uncached input", p.totalInputTokens], ["Cache read", p.totalCacheReadTokens], ["Cache write", p.totalCacheWriteTokens], ["Output", p.totalOutputTokens]];
          let cells = 0;
          const track = Math.max(1, Math.min(48, width - 2));
          expandedBlock.push(...wrapTextWithAnsi4(`${formatInteger2(p.totalRequests)} requests \xB7 ${formatInteger2(p.failedRequests)} failed \xB7 ${formatInteger2(p.totalPremiumRequests)} premium \xB7 Output ${formatInteger2(p.totalOutputTokens)} \xB7 API-equivalent cost ${costWithUnpriced(p.totalCost, p.unpricedRequests)}`, width));
          expandedBlock.push(mix.map(([_, value], i) => {
            const next = Math.round(mix.slice(0, i + 1).reduce((sum, [, n]) => sum + n, 0) / Math.max(1, p.totalTokens) * track);
            const text = ctx.theme.fg(SERIES_COLORS2[i % SERIES_COLORS2.length], glyph(preset, "barFill").repeat(Math.max(0, next - cells)));
            cells = next;
            return text;
          }).join(""));
          mix.forEach(([label, value], i) => expandedBlock.push(`${ctx.theme.fg(SERIES_COLORS2[i % SERIES_COLORS2.length], glyph(preset, "legendKey"))} ${label}: ${formatInteger2(value)} \xB7 ${p.totalTokens > 0 ? formatPercent2(value / p.totalTokens) : "\u2014"}`));
        }
        const detail = p ? 1 + expandedBlock.length : 1;
        const viewport = recordViewport(rows, providerRow, Math.max(1, height - lines.length - detail), rows.length, 0);
        lines.push(...dataTable(ctx, width, "", [
          { key: "provider", header: "Provider", align: "left" },
          { key: "tokens", header: "Tokens", align: "right" },
          { key: "requests", header: "Requests", align: "right", priority: 1 },
          { key: "cost", header: "API-equiv.", align: "right", priority: 2 },
          { key: "output", header: "Output", align: "right", priority: 3 }
        ], viewport.rows.map((p) => ({ provider: p.provider, tokens: compactTokens(p.totalTokens), requests: formatInteger2(p.totalRequests), cost: costWithUnpriced(p.totalCost, p.unpricedRequests), output: compactTokens(p.totalOutputTokens) })), providerRow - viewport.start));
        if (p) {
          selectedProvider = p.provider;
          lines.push(sectionHeading(ctx, width, `Selected ${p.provider}`, `${p.models} models \xB7 ${p.avgTokensPerSecond === null ? "\u2014" : p.avgTokensPerSecond.toFixed(1)} tok/s`, true));
          lines.push(...expandedBlock);
        }
        if (!rows.length)
          lines.push("No provider activity in this range");
      } else if (view === 1) {
        const chart = burn();
        point = Math.max(0, Math.min(chart.axis.length - 1, point));
        lines.push(`Metric ${chart.metricName} \xB7 ${chart.step < 3600000 ? "5 minutes" : chart.step < 86400000 ? "hour" : "day"} \xB7 top six + Other`);
        if (chart.metricName === "output" && data.series.some((p) => p.outputTokens === undefined))
          lines.push("Output burn unavailable for older payload points (gaps, not zero).");
        const ts = chart.axis[point];
        lines.push(`Point ${new Date(ts).toISOString()} \xB7 legend ${chart.rows[legend % Math.max(1, chart.rows.length)]?.label ?? "none"}`);
        for (const r of chart.rows) {
          const value = r.values[point];
          if (!hiddenBurn.has(r.key) && value !== null && value !== undefined)
            lines.push(`${r.label}: ${chart.metricName === "cost" ? costWithUnpriced(value, chart.unpriced.get(r.key)?.[point] ?? 0) : formatInteger2(value)} ${chart.metricName === "cost" ? "API-equivalent" : chart.metricName}`);
        }
        const rows = chart.rows.map((r) => ({ ...r, legendValue: chart.metricName === "cost" ? costWithUnpriced(r.values.reduce((sum, value) => sum + (value ?? 0), 0), (chart.unpriced.get(r.key) ?? []).reduce((sum, count) => sum + count, 0)) : formatInteger2(r.values.reduce((sum, value) => sum + (value ?? 0), 0)) }));
        lines.push(...renderTimeSeries(ctx, chart.axis, rows, width, point, { hidden: hiddenBurn, stacked: true, format: chart.metricName === "cost" ? formatCost2 : compactTokens, formatValue: chart.metricName === "cost" ? (key, value, point) => costWithUnpriced(value ?? 0, chart.unpriced.get(key)?.[point] ?? 0) : undefined, unit: chart.metricName === "cost" ? "USD API-equiv." : chart.metricName, height: 4, selectedKey: chart.rows[legend % Math.max(1, chart.rows.length)]?.key }));
      } else if (view === 2) {
        const hours = Array.from({ length: 24 }, () => ({ tokens: 0, output: 0, requests: 0 }));
        for (const p of data.hourly)
          if (peakProvider === null || p.provider === peakProvider) {
            hours[p.hour].tokens += p.totalTokens;
            hours[p.hour].output += p.outputTokens;
            hours[p.hour].requests += p.requests;
          }
        const peak = hours.reduce((best, p, i) => p.tokens > hours[best].tokens ? i : best, 0);
        lines.push(`Provider ${peakProvider ?? "All providers"} \xB7 peak ${hours[peak].tokens > 0 ? `${String(peak).padStart(2, "0")}:00` : "none"}`, `Hour ${String(hour).padStart(2, "0")}:00 local \xB7 ${formatInteger2(hours[hour].tokens)} tokens \xB7 ${formatInteger2(hours[hour].output)} output \xB7 ${formatInteger2(hours[hour].requests)} requests`);
        const max = Math.max(0, ...hours.map((p) => p.tokens));
        const track = Math.max(1, Math.min(36, width - 25));
        for (let i = Math.max(0, hour - 4);i < Math.min(24, Math.max(9, hour + 5)); i++)
          lines.push(`${i === hour ? glyph(preset, "rowCursor") : " "} ${String(i).padStart(2, "0")} ${ctx.theme.fg(i === peak ? "warning" : "success", glyph(preset, "barFill").repeat(max > 0 ? Math.round(hours[i].tokens / max * track) : 0))} ${compactTokens(hours[i].tokens)}`);
        if (max === 0)
          lines.push("No activity in this range");
      } else if (view === 3) {
        if (insights === null)
          lines.push(windowsLoading ? "Loading subscription windows (you can still switch views)\u2026" : "Subscription window payload unavailable");
        const rows = sortedWindows();
        const selected = rows.findIndex((i) => i.provider === picked?.provider && i.windowKey === picked?.windowKey);
        const i = rows[selected];
        lines.push(sectionHeading(ctx, width, "Subscription windows", `${WINDOW_SORTS[windowSort]} ${descending ? "\u2193" : "\u2191"} \xB7 ${rows.length} windows`, true));
        const blockStart = lines.length;
        const viewport = recordViewport(rows, Math.max(0, selected), Math.max(1, height - lines.length + 10), rows.length);
        lines.push(...dataTable(ctx, width, "", [
          { key: "window", header: "Provider / window", align: "left" },
          { key: "burned", header: "Burned", align: "right" },
          { key: "accounts", header: "Accounts", align: "right", priority: 1 },
          { key: "capacity", header: "Capacity", align: "right", priority: 2 },
          { key: "exhaustions", header: "Exhaustions", align: "right", priority: 3 }
        ], viewport.rows.map((i) => ({ window: `${i.provider} / ${i.windowLabel}`, burned: i.fractionConsumed.toFixed(2), accounts: formatInteger2(i.accounts), capacity: i.estTokensPerWindow === null ? "\u2014" : compactTokens(i.estTokensPerWindow), exhaustions: formatInteger2(i.exhaustedEvents) })), selected - viewport.start));
        ctx.reportHits?.(viewport.rows.map((w, line) => ({
          rowStart: blockStart + 1 + line,
          rowEnd: blockStart + 2 + line,
          colStart: 0,
          colEnd: width,
          action: { type: "selectRow", key: `${w.provider}::${w.windowKey}` }
        })));
        if (i)
          lines.push(ctx.theme.bold(`${i.provider} \xB7 ${i.windowLabel}`), `Windows burned ${i.fractionConsumed.toFixed(2)} \xB7 resets ${i.cycles} \xB7 capacity ${i.estTokensPerWindow === null ? "\u2014 (too little consumed to estimate)" : `${compactTokens(i.estTokensPerWindow)} tokens/window`}`, `Peak ${formatPercent2(i.peakConcurrentFraction)} summed \xB7 fleet ${i.accounts} accounts \xB7 fleet load ${i.accounts ? formatPercent2(i.peakConcurrentFraction / i.accounts) : "\u2014"}`, `Accounts needed ${i.idealAccounts} at <90% \xB7 have ${i.accounts} \xB7 ${i.idealAccounts > i.accounts ? `short ${i.idealAccounts - i.accounts}` : `headroom ${i.accounts - i.idealAccounts}`} \xB7 exhaustions ${i.exhaustedEvents}`);
        if (insights && !insights.length)
          lines.push("No usage snapshots in this range. Snapshots accumulate when limits are fetched (footer, /usage, omp usage).");
        lines.push("Capacity uses upstream broker fleet tokens when present, otherwise local provider tokens; it is an estimate, not billing.");
      } else {
        lines.push(`Provider ${picked?.provider ?? "\u2014"} \xB7 window ${insights?.find((i) => i.provider === picked?.provider && i.windowKey === picked?.windowKey)?.windowLabel ?? "\u2014"}`);
        if (!picked)
          lines.push(insights?.length === 0 ? "No usage snapshots in this range" : "Waiting for subscription windows");
        else if (!accountData)
          lines.push(accountsLoading ? "Loading account histories (input remains active)\u2026" : "No account-history payload available");
        const rows = accountRows();
        const retained = rows.findIndex((r) => JSON.stringify([r.series.windowKey, r.series.accountKey]) === selectedAccount);
        row = retained >= 0 ? retained : Math.max(0, Math.min(row, rows.length - 1));
        const current = rows[row];
        lines.push(sectionHeading(ctx, width, "Accounts / all provider windows", `${ACCOUNT_SORTS[accountSort]} ${descending ? "\u2193" : "\u2191"}`, true));
        const viewport = recordViewport(rows, row, Math.max(1, height - lines.length - 4), rows.length);
        lines.push(...dataTable(ctx, width, "", [
          { key: "account", header: "Account / window", align: "left" },
          { key: "latest", header: "Latest", align: "right" },
          { key: "peak", header: "Peak", align: "right", priority: 1 },
          { key: "samples", header: "Snapshots", align: "right", priority: 2 },
          { key: "resets", header: "Resets", align: "right", priority: 3 }
        ], viewport.rows.map((r) => ({ account: `${r.name} / ${r.series.windowLabel}`, latest: `${r.latest ? formatPercent2(r.latest.fraction) : "\u2014"}${r.latest?.exhausted ? " exhausted" : ""}`, peak: r.peak === null ? "\u2014" : formatPercent2(r.peak), samples: formatInteger2(r.samples), resets: formatInteger2(r.resets) })), row - viewport.start));
        if (current) {
          selectedAccount = JSON.stringify([current.series.windowKey, current.series.accountKey]);
          lines.push(ctx.theme.bold(`${current.name} \xB7 ${current.series.windowLabel}`), `Account key ${current.series.accountKey}`, `Latest ${current.latest ? `${formatPercent2(current.latest.fraction)} \xB7 ${new Date(current.latest.timestamp).toISOString()} \xB7 ${current.latest.exhausted ? "EXHAUSTED" : current.latest.fraction >= 0.8 ? "HIGH" : "OK"}` : "No numeric reading"}`, `Peak ${current.peak === null ? "\u2014" : formatPercent2(current.peak)} \xB7 headroom ${current.latest ? formatPercent2(1 - current.latest.fraction) : "\u2014"} \xB7 resets ${current.resets} \xB7 snapshots ${current.samples}`);
        }
        const matching = rows.filter((r) => r.series.windowKey === picked?.windowKey).sort((a, b) => a.name.localeCompare(b.name));
        const chart = utilization(matching.map((r) => r.series));
        utilPoint = utilPoint < 0 ? chart.axis.length - 1 : Math.min(utilPoint, chart.axis.length - 1);
        const chartRows = chart.rows.map((r) => ({ ...r, label: matching.find((a) => a.series.accountKey === r.key)?.name ?? r.key }));
        if (chart.axis.length) {
          lines.push(`Utilization ${new Date(chart.axis[Math.max(0, utilPoint)]).toISOString()} \xB7 legend ${chartRows[legend % Math.max(1, chartRows.length)]?.label ?? "none"} \xB7 100% = exhausted capacity`);
          for (const r of chartRows)
            if (!hiddenAccounts.has(r.key))
              lines.push(`${r.label}: ${r.values[utilPoint] === null ? "No reading (gap)" : formatPercent2(r.values[utilPoint], 1)}`);
          const exhausted = chart.exhausted[utilPoint] ?? [];
          if (exhausted.length)
            lines.push(ctx.theme.fg("error", `EXHAUSTED: ${exhausted.map((key) => chartRows.find((r) => r.key === key)?.label ?? key).join(", ")}`));
          lines.push(...renderTimeSeries(ctx, chart.axis, chartRows, width, utilPoint, { hidden: hiddenAccounts, percent: true, format: (value) => formatPercent2(value, 1), unit: "capacity", height: 3, selectedKey: chartRows[legend % Math.max(1, chartRows.length)]?.key }));
        } else if (accountData)
          lines.push("No utilization readings for this window");
        lines.push(...wrapTextWithAnsi4(ctx.theme.fg("dim", "Readings hold at most six hours; longer silence is a gap, not zero."), width));
      }
      return boundLines(lines, width);
    },
    handleInput(input) {
      if (closed || input === "q")
        return false;
      if (input === "\t" || input === "v" || input === "\x1B[Z") {
        view = (view + (input === "\x1B[Z" ? VIEWS.length - 1 : 1)) % VIEWS.length;
        legend = 0;
        if (view >= 3 && !windowsLoading)
          loadWindows();
      } else if (input === "m" && view === 1)
        metric = (metric + 1) % METRICS.length;
      else if (input === "o") {
        if (view === 0)
          totalSort = (totalSort + 1) % TOTAL_SORTS.length;
        else if (view === 3)
          windowSort = (windowSort + 1) % WINDOW_SORTS.length;
        else if (view === 4)
          accountSort = (accountSort + 1) % ACCOUNT_SORTS.length;
        else
          return false;
      } else if (input === "d" && (view === 0 || view >= 3))
        descending = !descending;
      else if (input === "u") {
        loadWindows();
        if (picked)
          loadAccounts(picked.provider);
      } else if (input === "p" || input === "P") {
        if (view < 2)
          return false;
        const choices = view === 2 ? [null, ...data?.providers.map((p) => p.provider) ?? []] : [...new Set((insights ?? []).map((i) => i.provider))];
        if (choices.length) {
          const current = view === 2 ? peakProvider : picked?.provider ?? null;
          const next = choices[(Math.max(0, choices.indexOf(current)) + (input === "p" ? 1 : choices.length - 1)) % choices.length];
          if (view === 2)
            peakProvider = next;
          else {
            const i = insights?.find((i) => i.provider === next);
            if (i)
              selectWindow(i);
          }
        }
      } else if (input === "w" || input === "W") {
        if (view < 3)
          return false;
        const choices = (insights ?? []).filter((i) => i.provider === picked?.provider);
        if (choices.length) {
          const index = choices.findIndex((i) => i.windowKey === picked?.windowKey);
          selectWindow(choices[(Math.max(0, index) + (input === "w" ? 1 : choices.length - 1)) % choices.length]);
        }
      } else if (input === "h" || input === "l") {
        const delta = input === "l" ? 1 : -1;
        if (view === 1)
          point = Math.max(0, Math.min(burn().axis.length - 1, point + delta));
        else if (view === 2)
          hour = (hour + delta + 24) % 24;
        else if (view === 4) {
          const chart = utilization(accountRows().filter((r) => r.series.windowKey === picked?.windowKey).map((r) => r.series));
          utilPoint = Math.max(0, Math.min(chart.axis.length - 1, (utilPoint < 0 ? chart.axis.length - 1 : utilPoint) + delta));
        } else
          return false;
      } else if (input === "j" || input === "k" || input === "\x1B[A" || input === "\x1B[B") {
        const delta = input === "j" || input === "\x1B[B" ? 1 : -1;
        if (view === 0) {
          const rows = sortedTotals();
          const retained = rows.findIndex((p) => p.provider === selectedProvider);
          providerRow = Math.max(0, Math.min(rows.length - 1, (retained >= 0 ? retained : providerRow) + delta));
          selectedProvider = rows[providerRow]?.provider ?? null;
        } else if (view === 2)
          hour = (hour + delta + 24) % 24;
        else if (view === 3) {
          const rows = sortedWindows();
          const index = rows.findIndex((i) => i.provider === picked?.provider && i.windowKey === picked?.windowKey);
          const next = rows[Math.max(0, Math.min(rows.length - 1, index + delta))];
          if (next)
            selectWindow(next);
        } else if (view === 4) {
          const rows = accountRows();
          const retained = rows.findIndex((r) => JSON.stringify([r.series.windowKey, r.series.accountKey]) === selectedAccount);
          row = Math.max(0, Math.min(rows.length - 1, (retained >= 0 ? retained : row) + delta));
          const r = rows[row];
          if (r)
            selectedAccount = JSON.stringify([r.series.windowKey, r.series.accountKey]);
        } else
          return this.handleInput(delta > 0 ? "l" : "h");
      } else if ((input === "n" || input === "N") && (view === 1 || view === 4)) {
        const count = view === 1 ? burn().rows.length : accountRows().filter((r) => r.series.windowKey === picked?.windowKey).length;
        legend = (legend + (input === "n" ? 1 : Math.max(0, count - 1))) % Math.max(1, count);
      } else if (input === " " && (view === 1 || view === 4)) {
        const rows = view === 1 ? burn().rows : accountRows().filter((r) => r.series.windowKey === picked?.windowKey).sort((a, b) => a.name.localeCompare(b.name)).map((r) => ({ key: r.series.accountKey }));
        const r = rows[legend % Math.max(1, rows.length)];
        const hidden = view === 1 ? hiddenBurn : hiddenAccounts;
        if (r) {
          if (hidden.has(r.key))
            hidden.delete(r.key);
          else
            hidden.add(r.key);
        }
      } else if (input === "\r" || input === `
`) {
        if (view === 0) {
          const rows = sortedTotals();
          const p = rows.find((p) => p.provider === selectedProvider) ?? rows[providerRow];
          if (p) {
            selectedProvider = p.provider;
            expanded = expanded === p.provider ? null : p.provider;
          }
        } else if (view === 3)
          view = 4;
        else if (view === 4) {
          const rows = accountRows();
          const r = rows.find((r) => JSON.stringify([r.series.windowKey, r.series.accountKey]) === selectedAccount) ?? rows[row];
          if (r)
            selectWindow(r.series);
        } else
          return false;
      } else if (input === "\x1B" && expanded && view === 0)
        expanded = null;
      else
        return false;
      ctx.changed();
      return true;
    },
    handleHit(action) {
      if (action.type === "selectRow" && view === 3) {
        const [provider, windowKey] = action.key.split("::");
        const found = (insights ?? []).find((i) => i.provider === provider && i.windowKey === windowKey);
        if (found)
          selectWindow(found);
        ctx.changed();
      }
    },
    dispose() {
      closed = true;
      localGeneration++;
      windowsGeneration++;
      accountsGeneration++;
    }
  };
}

// src/tui/features/gain.ts
import { wrapTextWithAnsi as wrapTextWithAnsi5 } from "@oh-my-pi/pi-tui";
var SORTS = ["tokens", "source", "share", "bytes", "hits", "reduction"];
function createGainFeature(ctx) {
  let range = "24h";
  let project = null;
  let projects = [];
  let data = null;
  let generation = 0;
  let closed = false;
  let loading = false;
  let error = null;
  let focus = 0;
  let point = -1;
  let selected = 0;
  let selectedSource = null;
  let sort = 0;
  let descending = true;
  let reveal = 12;
  let expanded = false;
  const rows = () => {
    if (!data)
      return [];
    const result = Object.entries(data.bySource).map(([source, totals]) => ({ ...totals, source, share: data.overall.savedTokens > 0 ? totals.savedTokens / data.overall.savedTokens : 0 }));
    const key = SORTS[sort];
    return result.sort((a, b) => {
      const av = key === "source" ? a.source : key === "tokens" ? a.savedTokens : key === "bytes" ? a.savedBytes : key === "hits" ? a.hits : key === "share" ? a.share : a.reductionPercent ?? -1;
      const bv = key === "source" ? b.source : key === "tokens" ? b.savedTokens : key === "bytes" ? b.savedBytes : key === "hits" ? b.hits : key === "share" ? b.share : b.reductionPercent ?? -1;
      return (typeof av === "string" && typeof bv === "string" ? av.localeCompare(bv) : Number(av) - Number(bv)) * (descending ? -1 : 1);
    });
  };
  async function load(nextRange) {
    if (closed)
      return;
    if (range !== nextRange) {
      data = null;
      point = -1;
    }
    range = nextRange;
    const request = ++generation;
    const requestedProject = project;
    loading = true;
    error = null;
    ctx.changed();
    try {
      const next = await ctx.reader.api("/api/stats/gain", project === null ? { range } : { range, project });
      if (closed || request !== generation || requestedProject !== project)
        return;
      data = next;
      projects = [...next.projects];
      const history = savingsHistory(next.timeSeries, range, ctx.now());
      point = point < 0 ? history.axis.length - 1 : Math.min(point, history.axis.length - 1);
      selected = Math.min(selected, Math.max(0, rows().length - 1));
    } catch (cause) {
      if (closed || request !== generation)
        return;
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      if (!closed && request === generation) {
        loading = false;
        ctx.changed();
      }
    }
  }
  return {
    load,
    render(width, height) {
      const lines = [ctx.theme.bold(`Gain \xB7 ${range} \xB7 ${project ?? "All projects"}`)];
      if (error)
        lines.push(ctx.theme.fg("error", `Savings error: ${error}${data ? " \xB7 showing previous reading for this scope" : ""}`));
      if (data) {
        const t = data.overall;
        lines.push(...metricGrid(ctx, width, [
          { label: "Saved tokens", value: compactTokens(t.savedTokens), emphasis: "primary" },
          { label: "Saved bytes", value: formatBytes(t.savedBytes), hint: `${formatInteger2(t.hits)} recorded hits` },
          { label: "Reduction", value: t.reductionPercent === null ? "\u2014" : formatPercent2(t.reductionPercent), hint: t.reductionPercent === null ? "original size not recorded" : "recorded original bytes" }
        ]));
      }
      lines.push(...focusTabs(ctx, width, ["Projects", "History", "Sources"], focus));
      const hint = focus === 0 ? "p/P project \xB7 j/k select" : focus === 1 ? "h/l UTC day \xB7 p/P project" : "j/k source \xB7 o sort \xB7 d direction \xB7 Enter detail \xB7 + reveal";
      lines.push(...wrapTextWithAnsi5(ctx.theme.fg("dim", `Tab focus \xB7 ${hint}${loading ? " \xB7 loading" : ""}`), width));
      if (!data) {
        lines.push(loading ? "Loading scoped savings\u2026" : "No savings payload available");
        return boundLines(lines, width);
      }
      const t = data.overall;
      const history = savingsHistory(data.timeSeries, range, ctx.now());
      const empty = t.hits === 0 && data.timeSeries.length === 0;
      if (empty)
        lines.push(...wrapTextWithAnsi5(ctx.theme.fg("muted", `No savings recorded for ${project ?? "all projects"} in ${range}. ${range === "all" ? "Savings appear when snapcompact compacts tool output." : "Try a longer range."}`), width));
      if (focus === 0) {
        const options = projectOptions(projects, project);
        const viewport = recordViewport(options, options.indexOf(project), Math.max(1, height - lines.length + 10), reveal);
        lines.push(...dataTable(ctx, width, "Projects", [{ key: "project", header: "Project", align: "left" }], viewport.rows.map((p) => ({ project: p ?? "All projects" })), options.indexOf(project) - viewport.start));
      }
      if (!empty && focus === 1) {
        const i = Math.max(0, Math.min(history.axis.length - 1, point));
        lines.push(sectionHeading(ctx, width, "Saved per UTC day", history.axis.length ? new Date(history.axis[i]).toISOString().slice(0, 10) : "", true));
        if (history.axis.length)
          lines.push(`Day ${new Date(history.axis[i]).toISOString().slice(0, 10)} \xB7 saved ${formatInteger2(history.daily[i])} \xB7 cumulative ${formatInteger2(history.cumulative[i])}`);
        const chartHeight = Math.max(2, Math.min(4, Math.floor((height - lines.length - 10) / 2)));
        lines.push(...renderTimeSeries(ctx, history.axis, [{ key: "daily", label: "Saved per day", values: history.daily }], width, point, { format: compactTokens, unit: "tokens", height: chartHeight, legend: false }));
        lines.push(sectionHeading(ctx, width, "Cumulative saved tokens", "range-scoped", true));
        lines.push(...renderTimeSeries(ctx, history.axis, [{ key: "cumulative", label: "Cumulative", values: history.cumulative, colorIndex: 1 }], width, point, { cumulative: true, format: compactTokens, unit: "tokens", height: chartHeight, legend: false }));
      }
      const sourceRows = rows();
      const retained = sourceRows.findIndex((r) => r.source === selectedSource);
      selected = retained >= 0 ? retained : Math.max(0, Math.min(selected, sourceRows.length - 1));
      const chosen = sourceRows[selected];
      if (chosen)
        selectedSource = chosen.source;
      if (chosen && expanded && !empty) {
        lines.push(sectionHeading(ctx, width, chosen.source, "recorded source detail", focus === 2));
        lines.push(...wrapTextWithAnsi5(`Saved ${formatInteger2(chosen.savedTokens)} tokens \xB7 ${formatBytes(chosen.savedBytes)} \xB7 ${formatInteger2(chosen.hits)} hits \xB7 ${chosen.hits > 0 ? compactTokens(chosen.savedTokens / chosen.hits) : "\u2014"} tokens/hit`, width));
        lines.push(...wrapTextWithAnsi5(`Share ${formatPercent2(chosen.share)} \xB7 reduction ${chosen.reductionPercent === null ? "\u2014 (original size unknown)" : formatPercent2(chosen.reductionPercent)} \xB7 original ${formatBytes(chosen.originalBytes)} \xB7 output ${formatBytes(chosen.outputBytes)}`, width));
      }
      if (!empty && focus !== 1) {
        lines.push(sectionHeading(ctx, width, "By source", `${SORTS[sort]} ${descending ? "\u2193" : "\u2191"} \xB7 ${sourceRows.length} sources`, focus === 2));
        const viewport = recordViewport(sourceRows, selected, Math.max(1, height - lines.length + 10), reveal);
        lines.push(...dataTable(ctx, width, "", [
          { key: "source", header: "Source", align: "left" },
          { key: "tokens", header: "Saved tokens", align: "right" },
          { key: "hits", header: "Hits", align: "right", priority: 1 },
          { key: "bytes", header: "Bytes", align: "right", priority: 2 },
          { key: "share", header: "Share", align: "right", priority: 3 },
          { key: "reduction", header: "Reduction", align: "right", priority: 4 }
        ], viewport.rows.map((r) => ({ source: r.source, tokens: compactTokens(r.savedTokens), hits: formatInteger2(r.hits), bytes: formatBytes(r.savedBytes), share: formatPercent2(r.share), reduction: r.reductionPercent === null ? "\u2014" : formatPercent2(r.reductionPercent) })), selected - viewport.start));
      }
      return boundLines(lines, width);
    },
    handleInput(input) {
      if (closed || input === "q")
        return false;
      if (input === "\t" || input === "v" || input === "\x1B[Z")
        focus = (focus + (input === "\x1B[Z" ? 2 : 1)) % 3;
      else if (input === "p" || input === "P") {
        const options = projectOptions(projects, project);
        project = options[(options.indexOf(project) + (input === "p" ? 1 : options.length - 1)) % options.length];
        data = null;
        point = -1;
        selected = 0;
        selectedSource = null;
        load(range);
      } else if (input === "h" || input === "l") {
        const count = data ? savingsHistory(data.timeSeries, range, ctx.now()).axis.length : 0;
        point = Math.max(0, Math.min(count - 1, point + (input === "l" ? 1 : -1)));
        focus = 1;
      } else if (input === "j" || input === "k" || input === "\x1B[A" || input === "\x1B[B") {
        if (focus === 0)
          return this.handleInput(input === "j" || input === "\x1B[B" ? "p" : "P");
        const sourceRows = rows();
        const retained = sourceRows.findIndex((r) => r.source === selectedSource);
        selected = Math.max(0, Math.min(sourceRows.length - 1, (retained >= 0 ? retained : selected) + (input === "j" || input === "\x1B[B" ? 1 : -1)));
        selectedSource = sourceRows[selected]?.source ?? null;
        focus = 2;
      } else if (input === "o")
        sort = (sort + 1) % SORTS.length;
      else if (input === "d")
        descending = !descending;
      else if (input === "+" || input === "=")
        reveal += 12;
      else if (input === "\r" || input === `
`) {
        expanded = !expanded;
        focus = 2;
      } else if (input === "\x1B" && expanded)
        expanded = false;
      else
        return false;
      ctx.changed();
      return true;
    },
    dispose() {
      closed = true;
      generation++;
    }
  };
}

// src/tui/features/traces.ts
import { matchesKey, wrapTextWithAnsi as wrapTextWithAnsi7 } from "@oh-my-pi/pi-tui";

// node_modules/@oh-my-pi/omp-stats/src/client/traces/time-scale.ts
var ACTIVITY_PAD_MS = 2000;
var GAP_THRESHOLD_MS = 30000;
var GAP_BRIDGE_U = 8000;
function piecewise(tPoints, uPoints) {
  const n = tPoints.length;
  const domain = [uPoints[0], uPoints[n - 1]];
  const segmentAt = (points, value) => {
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = lo + hi + 1 >> 1;
      if (points[mid] <= value)
        lo = mid;
      else
        hi = mid - 1;
    }
    return Math.min(lo, n - 2);
  };
  return {
    toU(t) {
      if (t <= tPoints[0])
        return uPoints[0];
      if (t >= tPoints[n - 1])
        return uPoints[n - 1];
      const i = segmentAt(tPoints, t);
      const tSpan = tPoints[i + 1] - tPoints[i];
      if (tSpan <= 0)
        return uPoints[i];
      return uPoints[i] + (t - tPoints[i]) / tSpan * (uPoints[i + 1] - uPoints[i]);
    },
    toT(u) {
      if (u <= uPoints[0])
        return tPoints[0];
      if (u >= uPoints[n - 1])
        return tPoints[n - 1];
      const i = segmentAt(uPoints, u);
      const uSpan = uPoints[i + 1] - uPoints[i];
      if (uSpan <= 0)
        return tPoints[i];
      return tPoints[i] + (u - uPoints[i]) / uSpan * (tPoints[i + 1] - tPoints[i]);
    },
    domain,
    gaps: []
  };
}
function collectIntervals(tracks) {
  const intervals = [];
  for (const track of tracks) {
    for (const span of track.spans)
      intervals.push([span.start, span.end]);
  }
  intervals.sort((a, b) => a[0] - b[0]);
  return intervals;
}
function traceBounds(tracks) {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const track of tracks) {
    for (const span of track.spans) {
      if (span.start < min)
        min = span.start;
      if (span.end > max)
        max = span.end;
    }
  }
  if (!Number.isFinite(min))
    return [0, 1];
  return [min, Math.max(max, min + 1)];
}
function equalWidthScale(anchors, tMin, tMax) {
  const unique = [...new Set(anchors.filter((t) => t >= tMin && t <= tMax))].sort((a, b) => a - b);
  if (unique[0] !== tMin)
    unique.unshift(tMin);
  if (unique[unique.length - 1] !== tMax)
    unique.push(tMax);
  if (unique.length < 2)
    return piecewise([tMin, tMax], [tMin, tMax]);
  const total = tMax - tMin;
  const step = total / (unique.length - 1);
  const uPoints = unique.map((_, i) => tMin + i * step);
  return piecewise(unique, uPoints);
}
function compressedTimeScale(tracks, tMin, tMax) {
  const intervals = collectIntervals(tracks);
  const segments = [];
  for (const [s, e] of intervals) {
    const start = s - ACTIVITY_PAD_MS;
    const end = e + ACTIVITY_PAD_MS;
    const last = segments[segments.length - 1];
    if (last && start <= last[1]) {
      if (end > last[1])
        last[1] = end;
    } else {
      segments.push([start, end]);
    }
  }
  if (segments.length === 0)
    segments.push([tMin, tMax]);
  segments[0][0] = Math.max(segments[0][0], tMin);
  segments[segments.length - 1][1] = Math.min(Math.max(segments[segments.length - 1][1], segments[segments.length - 1][0]), tMax);
  const tPoints = [];
  const uPoints = [];
  const gaps = [];
  let u = segments[0][0];
  for (let i = 0;i < segments.length; i++) {
    const [s, e] = segments[i];
    if (i === 0) {
      tPoints.push(s);
      uPoints.push(u);
    } else {
      const prevEnd = segments[i - 1][1];
      const gap = s - prevEnd;
      if (gap > GAP_THRESHOLD_MS) {
        u += GAP_BRIDGE_U;
        gaps.push({ t0: prevEnd, t1: s, uMid: u - GAP_BRIDGE_U / 2 });
      } else {
        u += gap;
      }
      tPoints.push(s);
      uPoints.push(u);
    }
    u += Math.max(0, e - s);
    tPoints.push(e);
    uPoints.push(u);
  }
  const scale = piecewise(tPoints, uPoints);
  return { ...scale, gaps };
}
function buildScale(tracks, mode, compressIdle) {
  const [tMin, tMax] = traceBounds(tracks);
  if (mode === "turns") {
    const main = tracks.find((track) => track.id === "main");
    const anchors = (main?.spans ?? []).filter((span) => span.kind === "turn").map((span) => span.start);
    return equalWidthScale(anchors, tMin, tMax);
  }
  if (mode === "calls") {
    const anchors = [];
    for (const track of tracks) {
      for (const span of track.spans) {
        if (span.kind === "model" || span.kind === "tool" || span.kind === "background") {
          anchors.push(span.start, span.end);
        }
      }
    }
    return equalWidthScale(anchors, tMin, tMax);
  }
  if (compressIdle)
    return compressedTimeScale(tracks, tMin, tMax);
  return piecewise([tMin, tMax], [tMin, tMax]);
}

// src/tui/features/traces/model.ts
var KINDS = ["turn", "model", "tool", "subagent", "background"];
var MARKS = { turn: "I", model: "M", tool: "T", subagent: "A", background: "B" };
function transcriptRows(tracks) {
  const rows = [];
  for (const track of tracks) {
    for (const span of track.spans)
      rows.push({ key: span.id, time: span.start, span, track });
    track.markers.forEach((marker, i) => rows.push({ key: `${track.id}:marker:${i}`, time: marker.time, marker, track }));
  }
  return rows.sort((a, b) => a.time - b.time || a.key.localeCompare(b.key));
}
function trackMap(tracks) {
  return new Map(tracks.map((track) => [track.id, track]));
}
function ancestors(tracks, id, byId = trackMap(tracks)) {
  const result = [];
  const seen = new Set([id]);
  let parent = byId.get(id)?.parentId;
  while (parent && !seen.has(parent)) {
    result.push(parent);
    seen.add(parent);
    parent = byId.get(parent)?.parentId;
  }
  return result;
}
function visibleTracks(tracks, collapsed, byId = trackMap(tracks)) {
  return tracks.filter((track) => !ancestors(tracks, track.id, byId).some((id) => collapsed.has(id)));
}
function buildLanes(tracks, collapsed, byId = trackMap(tracks)) {
  const lanes = [];
  for (const track of visibleTracks(tracks, collapsed, byId)) {
    for (const kind of KINDS) {
      const ends = [];
      const packed = [];
      for (const span of track.spans.filter((span) => span.kind === kind).sort((a, b) => a.start - b.start)) {
        let index = ends.findIndex((end) => end <= span.start);
        if (index < 0)
          index = ends.length;
        ends[index] = Math.max(span.end, span.start + Number.EPSILON);
        (packed[index] ??= { track, kind, spans: [], ordinal: index }).spans.push(span);
      }
      lanes.push(...packed);
    }
  }
  return lanes;
}
function fit(scale) {
  return { u0: scale.domain[0], u1: scale.domain[1] };
}
function clampViewport(scale, viewport) {
  const [d0, d1] = scale.domain;
  const window = Math.min(d1 - d0, Math.max(Math.min(10, d1 - d0), viewport.u1 - viewport.u0));
  const u0 = Math.min(Math.max(d0, viewport.u0), d1 - window);
  return { u0, u1: u0 + window };
}
function remapViewport(previous, next, viewport) {
  return clampViewport(next, { u0: next.toU(previous.toT(viewport.u0)), u1: next.toU(previous.toT(viewport.u1)) });
}
function zoomViewport(scale, viewport, factor, cursor) {
  const fraction = Math.max(0, Math.min(1, cursor));
  const anchor = viewport.u0 + fraction * (viewport.u1 - viewport.u0);
  const window = (viewport.u1 - viewport.u0) * factor;
  return clampViewport(scale, { u0: anchor - window * fraction, u1: anchor + window * (1 - fraction) });
}
function overviewViewport(scale, viewport, cursor, anchor) {
  const [d0, d1] = scale.domain;
  const position = d0 + Math.max(0, Math.min(1, cursor)) * (d1 - d0);
  if (anchor !== null) {
    const start = d0 + Math.max(0, Math.min(1, anchor)) * (d1 - d0);
    return clampViewport(scale, { u0: Math.min(start, position), u1: Math.max(start, position) });
  }
  const size = viewport.u1 - viewport.u0;
  return clampViewport(scale, { u0: position - size / 2, u1: position + size / 2 });
}
function resizeOverview(scale, viewport, cursor, edge) {
  const [d0, d1] = scale.domain;
  const position = d0 + Math.max(0, Math.min(1, cursor)) * (d1 - d0);
  const minimum = Math.min(10, d1 - d0);
  return edge === "start" ? { u0: Math.max(d0, Math.min(position, viewport.u1 - minimum)), u1: viewport.u1 } : { u0: viewport.u0, u1: Math.min(d1, Math.max(position, viewport.u0 + minimum)) };
}
function revealSpan(scale, viewport, span, focus = false) {
  const start = scale.toU(span.start), end = scale.toU(span.end);
  if (!focus && start >= viewport.u0 && end <= viewport.u1)
    return viewport;
  const window = focus ? Math.max(10, (end - start) * 1.3) : Math.max(viewport.u1 - viewport.u0, end - start);
  return clampViewport(scale, { u0: (start + end - window) / 2, u1: (start + end + window) / 2 });
}
function spanCells(scale, viewport, span, width) {
  if (width < 1)
    return;
  const start = scale.toU(span.start), end = scale.toU(span.end);
  if (end < viewport.u0 || start > viewport.u1)
    return;
  const window = viewport.u1 - viewport.u0;
  const x0 = Math.max(0, Math.min(width - 1, Math.floor((start - viewport.u0) / window * width)));
  const x1 = Math.max(x0 + 1, Math.min(width, Math.ceil((end - viewport.u0) / window * width)));
  return [x0, x1];
}
function localWindow(rows, index, count) {
  const size = Math.max(1, count);
  const offset = Math.max(0, Math.min(Math.max(0, rows.length - size), index - Math.floor(size / 2)));
  return { rows: rows.slice(offset, offset + size), offset };
}

// src/tui/features/traces/render.ts
import { stripTerminalSequences, truncateToWidth as truncateToWidth10, visibleWidth as visibleWidth8, wrapTextWithAnsi as wrapTextWithAnsi6 } from "@oh-my-pi/pi-tui";
function clean(value) {
  return stripTerminalSequences(String(value ?? "")).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}
function bounded(lines, width) {
  return lines.map((line) => truncateToWidth10(line, Math.max(1, width)));
}
function sessionIdentity(title, file, project) {
  const recorded = clean(title).trim();
  if (recorded)
    return recorded;
  const name = clean(file).split("/").filter(Boolean).pop()?.replace(/\.jsonl$/i, "") || clean(file);
  const folder = clean(project).split("/").filter(Boolean).pop();
  return folder ? `${folder} \xB7 ${name}` : name;
}
function rowLabel(row, startedAt) {
  const span = row.span;
  return `${row.track.id} \xB7 ${span?.kind ?? row.marker?.kind} \xB7 ${span?.label ?? row.marker?.label} \xB7 +${formatDurationMs(row.time - startedAt)}${span ? ` \xB7 ${formatDurationMs(span.end - span.start)}${span.isError ? " \xB7 ERROR" : ""}${span.unterminated ? " \xB7 pending" : ""}` : ""}`;
}
function renderTimeline(options) {
  const { trace, scale, viewport, collapsed, selected, cursor, theme, search } = options;
  const tracks = Array.isArray(trace.tracks) ? trace.tracks : [];
  const preset = theme.getSymbolPreset();
  const width = Math.max(1, options.width);
  const labelWidth = Math.min(22, Math.max(4, Math.floor(width * 0.27)));
  const plotWidth = Math.max(1, width - labelWidth - 1);
  const lines = [];
  const full = { u0: scale.domain[0], u1: scale.domain[1] };
  const domainSize = full.u1 - full.u0;
  const windowStart = Math.max(0, Math.floor((viewport.u0 - full.u0) / domainSize * plotWidth));
  const windowEnd = Math.min(plotWidth - 1, Math.floor((viewport.u1 - full.u0) / domainSize * (plotWidth - 1)));
  const brush = Array(plotWidth).fill(" ");
  for (let x = windowStart;x <= windowEnd; x++)
    brush[x] = theme.fg("dim", glyph(preset, "axisRule"));
  brush[windowStart] = theme.fg("accent", "[");
  brush[windowEnd] = theme.fg("accent", "]");
  if (options.overviewAnchor !== null && options.overviewAnchor !== undefined)
    brush[Math.min(plotWidth - 1, Math.floor(options.overviewAnchor * (plotWidth - 1)))] = theme.fg("warning", "|");
  if (options.overviewCursor !== null && options.overviewCursor !== undefined)
    brush[Math.min(plotWidth - 1, Math.floor(options.overviewCursor * (plotWidth - 1)))] = theme.fg("accent", glyph(preset, "playhead"));
  lines.push(`${"Minimap".padEnd(labelWidth)} ${brush.join("")}`);
  for (const kind of KINDS) {
    const spans = tracks.flatMap((track) => track.spans.filter((span) => span.kind === kind));
    if (!spans.length)
      continue;
    const density = Array(plotWidth).fill(0), errors = Array(plotWidth).fill(false);
    for (const span of spans) {
      const cells = spanCells(scale, full, span, plotWidth);
      if (cells)
        for (let x = cells[0];x < cells[1]; x++) {
          density[x]++;
          errors[x] ||= !!span.isError;
        }
    }
    lines.push(`${`Overview ${kind}`.padEnd(labelWidth)} ${density.map((count, x) => count ? theme.fg(errors[x] ? "error" : SPAN_COLORS[kind], count > 1 ? glyph(preset, "barFill") : MARKS[kind]) : glyph(preset, "heatEmpty")).join("")}`);
  }
  lines.push(`Window +${formatDurationMs(scale.toT(viewport.u0) - (trace.startedAt ?? 0))} \u2192 +${formatDurationMs(scale.toT(viewport.u1) - (trace.startedAt ?? 0))} \xB7 ${(domainSize / (viewport.u1 - viewport.u0)).toFixed(1)}\xD7`);
  const ruler = Array(plotWidth).fill(glyph(preset, "axisRule"));
  for (const gap of scale.gaps) {
    const x = Math.floor((gap.uMid - viewport.u0) / (viewport.u1 - viewport.u0) * plotWidth);
    if (x >= 0 && x < plotWidth)
      ruler[x] = theme.fg("warning", "~");
  }
  ruler[Math.min(plotWidth - 1, Math.floor(cursor * (plotWidth - 1)))] = theme.fg("accent", glyph(preset, "playhead"));
  lines.push(`${"Cursor".padEnd(labelWidth)} ${ruler.join("")}`);
  const byId = trackMap(tracks), lanes = buildLanes(tracks, collapsed, byId), timelineRows = [];
  const lanesByTrack = new Map;
  for (const lane of lanes) {
    const group = lanesByTrack.get(lane.track.id);
    if (group)
      group.push(lane);
    else
      lanesByTrack.set(lane.track.id, [lane]);
  }
  for (const track of visibleTracks(tracks, collapsed, byId)) {
    timelineRows.push({ track });
    if (track.markers.length)
      timelineRows.push({ track, markers: true });
    for (const lane of lanesByTrack.get(track.id) ?? [])
      timelineRows.push({ track, lane });
  }
  const selectedIndex = timelineRows.findIndex((row) => row.lane?.spans.some((span) => span.id === selected) || row.markers && row.track.markers.some((_marker, index) => selected === `${row.track.id}:marker:${index}`));
  const visible = localWindow(timelineRows, Math.max(0, selectedIndex), Math.max(3, options.height - lines.length - 2));
  const needle = search.trim().toLowerCase();
  for (const row of visible.rows) {
    if (!row.lane && !row.markers) {
      const depth = ancestors(tracks, row.track.id, byId).length;
      const children = tracks.filter((track) => track.parentId === row.track.id).length;
      lines.push(theme.fg("muted", `${"  ".repeat(depth)}${collapsed.has(row.track.id) ? "+" : "\u2212"} ${clean(row.track.label)} [${row.track.id}]${children ? ` \xB7 ${children} children` : ""}${!row.track.spans.length && !row.track.markers.length ? " \xB7 no recorded events" : ""}`));
      continue;
    }
    const cells = Array(plotWidth).fill(" ");
    if (row.markers) {
      row.track.markers.forEach((marker, index) => {
        const u = scale.toU(marker.time);
        if (u < viewport.u0 || u > viewport.u1)
          return;
        const x = Math.min(plotWidth - 1, Math.floor((u - viewport.u0) / (viewport.u1 - viewport.u0) * plotWidth));
        const ink = theme.fg(selected === `${row.track.id}:marker:${index}` ? "accent" : "muted", glyph(preset, "trackMarker"));
        cells[x] = selected === `${row.track.id}:marker:${index}` ? theme.bg(SELECTION_BG.band, theme.bold(ink)) : ink;
      });
      const active = row.track.markers.some((_marker, index) => selected === `${row.track.id}:marker:${index}`);
      const label = truncateToWidth10(`${active ? glyph(preset, "rowCursor") : " "} Markers`, labelWidth, "");
      lines.push(`${active ? theme.bg(SELECTION_BG.band, theme.fg("accent", label.padEnd(labelWidth))) : label.padEnd(labelWidth)} ${cells.join("")}`);
      continue;
    }
    const lane = row.lane;
    const spans = [...lane.spans].sort((a, b) => Number(a.id === selected) - Number(b.id === selected));
    for (const span of spans) {
      const bounds = spanCells(scale, viewport, span, plotWidth);
      if (!bounds)
        continue;
      const [start, end] = bounds;
      const match = needle && `${span.label} ${span.detail ?? ""} ${lane.track.label}`.toLowerCase().includes(needle);
      const text = clean(span.label).replace(/\s+/g, " ");
      const label = end - start >= 7 ? Array.from(text).filter((char) => visibleWidth8(char) === 1) : [];
      for (let x = start;x < end; x++) {
        let mark = label[x - start - 1] ?? MARKS[span.kind];
        if (x === start && span.id === selected)
          mark = glyph(preset, "rowCursor");
        else if (x === start && match)
          mark = "*";
        const ink = theme.fg(span.isError ? "error" : SPAN_COLORS[span.kind], mark);
        cells[x] = span.id === selected ? theme.bg(SELECTION_BG.band, theme.bold(ink)) : ink;
      }
    }
    const active = lane.spans.some((span) => span.id === selected);
    const label = truncateToWidth10(`${active ? glyph(preset, "rowCursor") : MARKS[lane.kind]} ${lane.track.id} ${lane.kind}${lane.ordinal ? ` #${lane.ordinal + 1}` : ""}`, labelWidth, "");
    const padded = `${label}${" ".repeat(Math.max(0, labelWidth - visibleWidth8(label)))}`;
    lines.push(`${active ? theme.bg(SELECTION_BG.band, theme.bold(theme.fg("accent", padded))) : padded} ${cells.join("")}`);
  }
  if (!tracks.some((track) => track.spans.length || track.markers.length))
    lines.push("No recorded spans or markers in this trace.");
  if (visible.rows.length < timelineRows.length)
    lines.push(theme.fg("dim", `Rows ${visible.offset + 1}\u2013${visible.offset + visible.rows.length}/${timelineRows.length} \xB7 \u2191/\u2193 reveal \xB7 Tab panes`));
  lines.push(...wrapTextWithAnsi6(`I input \xB7 M model \xB7 T tool \xB7 A agent \xB7 B background \xB7 ${glyph(preset, "trackMarker")} marker \xB7 ~ compressed idle`, width));
  return bounded(lines, width);
}
function renderEntry(row, entry, loading, error, raw, width) {
  const span = row?.span;
  const lines = row ? [clean(rowLabel(row, row.time)), `Track: ${clean(row.track.label)} \xB7 ${clean(row.track.file)}`] : [];
  if (span) {
    lines.push(`Start: ${new Date(span.start).toISOString()} \xB7 End: ${new Date(span.end).toISOString()}`);
    if (span.detail)
      lines.push(`${span.kind === "subagent" ? "Task" : span.kind === "tool" ? "Arguments" : "Detail"}: ${clean(span.detail)}`);
    if (span.kind === "model")
      lines.push(`Model: ${clean(span.model ?? "unknown")} \xB7 Tokens: ${formatInteger(span.tokens ?? 0)} \xB7 Cost: ${span.cost === undefined ? "N/A" : formatEstimatedCost(span.cost, 0)} \xB7 TTFT: ${formatDurationMs(span.ttft ?? null)}`);
    if (span.childTrackId)
      lines.push(`Child: ${clean(span.childTrackId)} \xB7 o reveal child \xB7 O open child's transcript`);
  }
  if (loading)
    lines.push("Loading full journal entry\u2026");
  if (error)
    lines.push(`Entry unavailable: ${clean(error)}`);
  const record = entry && typeof entry === "object" ? entry : {};
  const msg = record.message && typeof record.message === "object" ? record.message : {};
  for (const key of ["role", "model", "provider", "stopReason", "duration", "ttft", "toolName", "isError", "errorMessage"]) {
    if (msg[key] !== undefined)
      lines.push(`${key}: ${clean(msg[key])}`);
  }
  if (msg.usage && typeof msg.usage === "object") {
    const usage = msg.usage;
    lines.push(`Usage: input ${clean(usage.input)} \xB7 output ${clean(usage.output)} \xB7 cache read ${clean(usage.cacheRead)} \xB7 cache write ${clean(usage.cacheWrite)} \xB7 total ${clean(usage.totalTokens)}`);
    if (usage.cost)
      lines.push(`Component costs: ${clean(JSON.stringify(usage.cost))}`);
  }
  if (typeof msg.content === "string")
    lines.push("Text:", clean(msg.content));
  else if (Array.isArray(msg.content))
    for (const block of msg.content) {
      if (!block || typeof block !== "object")
        continue;
      if (typeof block.text === "string")
        lines.push(`${clean(block.type)}:`, clean(block.text));
      else if (block.type === "toolCall")
        lines.push(`Tool call ${clean(block.name)} (${clean(block.id)}):`, clean(JSON.stringify(block.arguments, null, 2)));
    }
  if (msg.details !== undefined)
    lines.push("Tool details:", clean(JSON.stringify(msg.details, null, 2)));
  if (row && !loading && entry === null && span?.entryId === undefined)
    lines.push("No journal entry is associated with this span/marker.");
  if (raw)
    lines.push("Raw JSON:", clean(JSON.stringify(entry ?? span ?? row?.marker, null, 2)));
  return lines.flatMap((line) => wrapTextWithAnsi6(line, Math.max(1, width)));
}

// src/tui/features/traces.ts
var SESSION_SORTS = ["started", "title", "duration", "requests", "tools", "agents", "tokens", "cost"];
var TOOL_SORTS = ["total", "tool", "calls", "errors", "average", "max"];
var FOCI = ["timeline", "transcript", "tools", "children", "minimap"];
function createTracesFeature(ctx) {
  let closed = false, generation = 0, entryGeneration = 0;
  let loading = false, error = null, notice = "";
  let sessions = [], listSearch = "", sessionSelected = null;
  let sessionsLoaded = false;
  let listLimit = 200, revealed = 50, listSort = "started", listDescending = true;
  let toolSort = "total", toolDescending = true;
  let state = null;
  const history = [];
  let editing = null, draft = "";
  let detail = false, raw = false, entry = null, entryLoading = false, entryError = null;
  let timelinePlotWidth = 1;
  let unmappedTarget = null;
  let rowCache = null;
  function allRows() {
    const tracks = state?.trace?.tracks;
    if (!tracks)
      return [];
    if (rowCache?.tracks !== tracks)
      rowCache = { tracks, rows: transcriptRows(tracks) };
    return rowCache.rows;
  }
  function changed() {
    if (!closed)
      ctx.changed();
  }
  function rows() {
    if (!state?.trace)
      return [];
    const needle = state.search.trim().toLowerCase();
    return allRows().filter((row) => (!needle || `${row.span?.label ?? row.marker?.label} ${row.span?.detail ?? ""} ${row.track.label}`.toLowerCase().includes(needle)) && (!state?.toolFilter || row.span?.kind === "tool" && row.span.label === state.toolFilter));
  }
  function selectedRow() {
    return state?.trace ? allRows().find((row) => row.key === state?.selected) : undefined;
  }
  function sortedSessions() {
    const needle = listSearch.trim().toLowerCase();
    const value = (row) => {
      switch (listSort) {
        case "title":
          return sessionIdentity(row.title, row.file, row.folder).toLowerCase();
        case "duration":
          return row.endedAt - row.startedAt;
        case "requests":
          return row.requests;
        case "tools":
          return row.toolCalls;
        case "agents":
          return row.subagents;
        case "tokens":
          return row.totalTokens;
        case "cost":
          return row.costTotal;
        default:
          return row.startedAt;
      }
    };
    return sessions.filter((row) => !needle || `${row.title ?? ""} ${row.folder} ${row.file.split("/").pop()} ${row.models.join(" ")}`.toLowerCase().includes(needle)).sort((a, b) => {
      const av = value(a), bv = value(b);
      const result = typeof av === "string" && typeof bv === "string" ? av.localeCompare(bv) : Number(av) - Number(bv);
      return (listDescending ? -result : result) || a.file.localeCompare(b.file);
    });
  }
  function sortedTools() {
    const value = (row) => {
      switch (toolSort) {
        case "tool":
          return row.tool;
        case "calls":
          return row.calls;
        case "errors":
          return row.errors;
        case "average":
          return row.calls ? row.totalMs / row.calls : 0;
        case "max":
          return row.maxMs;
        default:
          return row.totalMs;
      }
    };
    return [...state?.trace?.summary.toolStats ?? []].sort((a, b) => {
      const av = value(a), bv = value(b);
      const result = typeof av === "string" && typeof bv === "string" ? av.localeCompare(bv) : Number(av) - Number(bv);
      return (toolDescending ? -result : result) || a.tool.localeCompare(b.tool);
    });
  }
  function resetEntry() {
    entryGeneration++;
    entry = null;
    entryLoading = false;
    entryError = null;
    raw = false;
  }
  async function loadEntry(row, target) {
    resetEntry();
    const request = target ?? (row?.span?.entryId ? { file: row.track.file, id: row.span.entryId } : null);
    if (!request) {
      changed();
      return;
    }
    const id = ++entryGeneration, view = state, selection = state?.selected;
    entryLoading = true;
    changed();
    try {
      const response = await ctx.reader.api("/api/session/entry", request);
      if (closed || id !== entryGeneration || state !== view || state?.selected !== selection)
        return;
      entry = response.entry;
    } catch (cause) {
      if (closed || id !== entryGeneration || state !== view)
        return;
      entryError = cause instanceof Error ? cause.message : String(cause);
    } finally {
      if (!closed && id === entryGeneration && state === view) {
        entryLoading = false;
        changed();
      }
    }
  }
  function select(row, open = false) {
    if (!state?.trace)
      return;
    unmappedTarget = null;
    state.selected = row.key;
    for (const id of ancestors(state.trace.tracks, row.track.id))
      state.collapsed.delete(id);
    if (row.span)
      state.viewport = revealSpan(state.scale, state.viewport, row.span);
    else {
      const u = state.scale.toU(row.time), size = state.viewport.u1 - state.viewport.u0;
      if (u < state.viewport.u0 || u > state.viewport.u1)
        state.viewport = clampViewport(state.scale, { u0: u - size / 2, u1: u + size / 2 });
    }
    const u = state.scale.toU(row.span ? (row.span.start + row.span.end) / 2 : row.time);
    state.cursor = Math.max(0, Math.min(1, (u - state.viewport.u0) / (state.viewport.u1 - state.viewport.u0)));
    resetEntry();
    detail = open;
    if (open)
      loadEntry(row);
    changed();
  }
  async function loadSessions() {
    const id = ++generation;
    loading = true;
    error = null;
    changed();
    try {
      const queries = [ctx.reader.api("/api/sessions", { limit: String(listLimit) })];
      if (listSearch)
        queries.push(ctx.reader.api("/api/sessions", { limit: String(listLimit), q: listSearch }));
      const responses = await Promise.all(queries);
      if (closed || id !== generation || state)
        return;
      const byFile = new Map;
      for (const response of responses) {
        if (!Array.isArray(response)) {
          error = "Session list payload is not an array";
          return;
        }
        for (const row of response)
          byFile.set(row.file, row);
      }
      sessions = [...byFile.values()];
      sessionsLoaded = true;
      const visible = sortedSessions();
      if (!visible.some((row) => row.file === sessionSelected))
        sessionSelected = visible[0]?.file ?? null;
    } catch (cause) {
      if (!closed && id === generation)
        error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      if (!closed && id === generation) {
        loading = false;
        changed();
      }
    }
  }
  async function loadTrace(view, entryId, requestedFile = view.file) {
    const id = ++generation;
    loading = true;
    error = null;
    changed();
    try {
      const trace = await ctx.reader.api("/api/session/trace", { file: view.file });
      if (closed || id !== generation || state !== view)
        return;
      if (!trace || !Array.isArray(trace.tracks) || !trace.summary) {
        error = "Trace payload missing tracks/summary";
        return;
      }
      const previous = view.scale;
      view.scale = buildScale(trace.tracks, view.mode, view.compress);
      view.viewport = view.trace ? remapViewport(previous, view.scale, view.viewport) : fit(view.scale);
      const firstLoad = !view.trace;
      view.trace = trace;
      if (firstLoad) {
        for (const track of trace.tracks)
          if (track.parentId)
            view.collapsed.add(track.id);
      }
      const all = transcriptRows(trace.tracks);
      rowCache = { tracks: trace.tracks, rows: all };
      const requested = entryId ? all.find((row) => row.track.file === requestedFile && row.span?.entryId === entryId) : undefined;
      const retained = all.find((row) => row.key === view.selected);
      if (requested)
        select(requested, true);
      else if (!retained) {
        view.selected = all[0]?.key ?? null;
        resetEntry();
        detail = false;
      }
      if (entryId && !requested) {
        notice = `Entry ${entryId} has no assembled span; timing is unavailable.`;
        unmappedTarget = { file: requestedFile, id: entryId };
        detail = true;
        await loadEntry(null, unmappedTarget);
      } else if (unmappedTarget && detail && !entryId) {
        loadEntry(null, unmappedTarget);
      } else if (retained && detail && !entryId)
        loadEntry(retained);
      view.toolSelected ??= trace.summary.toolStats[0]?.tool ?? null;
      view.childSelected ??= trace.tracks.find((track) => track.parentId)?.id ?? trace.tracks[0]?.id ?? null;
    } catch (cause) {
      if (!closed && id === generation && state === view)
        error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      if (!closed && id === generation && state === view) {
        loading = false;
        changed();
      }
    }
  }
  async function openTrace(file, entryId, recordHistory = true) {
    if (closed)
      return;
    if (state?.file === file) {
      await loadTrace(state, entryId, file);
      return;
    }
    if (state && recordHistory)
      history.push({ ...state, collapsed: new Set(state.collapsed) });
    resetEntry();
    detail = false;
    notice = "";
    editing = null;
    unmappedTarget = null;
    const scale = buildScale([], "time", true);
    state = {
      file,
      trace: null,
      scale,
      viewport: fit(scale),
      mode: "time",
      compress: true,
      selected: null,
      collapsed: new Set,
      cursor: 0.5,
      focus: "timeline",
      search: "",
      toolFilter: null,
      toolSelected: null,
      childSelected: null,
      overviewCursor: 0.5,
      overviewAnchor: null
    };
    await loadTrace(state, entryId, file);
  }
  function back() {
    if (!history.length && ctx.backToOrigin?.())
      return;
    generation++;
    loading = false;
    error = null;
    resetEntry();
    detail = false;
    notice = "";
    unmappedTarget = null;
    state = history.pop() ?? null;
    if (!state && !sessions.length)
      loadSessions();
    changed();
  }
  function cycleMatch(direction) {
    const matches = rows().filter((row) => row.span);
    if (!matches.length) {
      notice = "No matching spans.";
      changed();
      return;
    }
    const current = matches.findIndex((row) => row.key === state?.selected);
    const next = current < 0 ? direction > 0 ? 0 : matches.length - 1 : (current + direction + matches.length) % matches.length;
    select(matches[next]);
  }
  function changeAxis(mode, compress) {
    if (!state?.trace)
      return;
    const next = buildScale(state.trace.tracks, mode, compress);
    const cursorTime = state.scale.toT(state.viewport.u0 + state.cursor * (state.viewport.u1 - state.viewport.u0));
    const [oldStart, oldEnd] = state.scale.domain;
    const overviewTime = state.scale.toT(oldStart + state.overviewCursor * (oldEnd - oldStart));
    const anchorTime = state.overviewAnchor === null ? null : state.scale.toT(oldStart + state.overviewAnchor * (oldEnd - oldStart));
    state.viewport = remapViewport(state.scale, next, state.viewport);
    state.scale = next;
    state.mode = mode;
    state.compress = compress;
    state.cursor = Math.max(0, Math.min(1, (next.toU(cursorTime) - state.viewport.u0) / (state.viewport.u1 - state.viewport.u0)));
    const [start, end] = next.domain;
    state.overviewCursor = Math.max(0, Math.min(1, (next.toU(overviewTime) - start) / (end - start)));
    state.overviewAnchor = anchorTime === null ? null : Math.max(0, Math.min(1, (next.toU(anchorTime) - start) / (end - start)));
    changed();
  }
  function childAction(openFile) {
    if (!state?.trace)
      return;
    const selected = selectedRow();
    const id = state.focus === "children" ? state.childSelected : selected?.span?.childTrackId ?? selected?.track.id;
    const track = state.trace.tracks.find((item) => item.id === id);
    if (!track) {
      notice = "Select a child track or agent span first.";
      changed();
      return;
    }
    if (openFile) {
      openTrace(track.file);
      return;
    }
    for (const ancestor of ancestors(state.trace.tracks, track.id))
      state.collapsed.delete(ancestor);
    const first = transcriptRows([track])[0];
    if (first) {
      state.toolFilter = null;
      state.search = "";
      state.focus = "timeline";
      select(first);
    } else {
      notice = "This child has no recorded spans or markers.";
      changed();
    }
  }
  async function copySelection() {
    const id = entryGeneration, view = state;
    const row = selectedRow();
    const value = detail ? entry ?? (unmappedTarget ? undefined : row?.span ?? row?.marker) : row?.span ?? row?.marker ?? state?.trace ?? sessions.find((item) => item.file === sessionSelected);
    if (entryLoading) {
      notice = "Entry is still loading; wait before copying its JSON.";
      changed();
      return;
    }
    if (!value) {
      notice = "Nothing selected to copy.";
      changed();
      return;
    }
    try {
      await ctx.copy(JSON.stringify(value, null, 2));
      if (!closed && state === view && id === entryGeneration)
        notice = "Copied JSON.";
    } catch (cause) {
      if (!closed && state === view && id === entryGeneration)
        notice = `Clipboard failed: ${cause instanceof Error ? cause.message : String(cause)}`;
    }
    changed();
  }
  return {
    async load(_range) {
      if (closed)
        return;
      if (state)
        await loadTrace(state);
      else
        await loadSessions();
    },
    get inputMode() {
      return editing ? "text" : "navigation";
    },
    openTrace(file, entryId) {
      history.length = 0;
      return openTrace(file, entryId, false);
    },
    dispose() {
      closed = true;
      generation++;
      entryGeneration++;
      history.length = 0;
    },
    render(width, height) {
      const w = Math.max(1, width);
      const lines = [];
      const add = (text) => lines.push(...wrapTextWithAnsi7(text, w));
      const hint = (text) => add(ctx.theme.fg("dim", text));
      if (notice)
        add(ctx.theme.fg("warning", clean(notice)));
      if (error)
        add(ctx.theme.fg("error", `Trace read failed: ${clean(error)} \xB7 u retry`));
      if (loading)
        hint(state?.trace || sessions.length ? "Refreshing recorded data\u2026" : "Loading recorded data\u2026");
      if (editing)
        add(ctx.theme.fg("accent", `Search: ${clean(draft)}_ \xB7 Enter apply \xB7 Esc cancel`));
      if (!state) {
        const all = sortedSessions();
        const selectedIndex = all.findIndex((row) => row.file === sessionSelected);
        if (selectedIndex >= revealed)
          revealed = Math.ceil((selectedIndex + 1) / 50) * 50;
        const shown = all.slice(0, revealed);
        let index = shown.findIndex((row) => row.file === sessionSelected);
        if (index < 0 && shown.length) {
          sessionSelected = shown[0].file;
          index = 0;
        }
        const totals = all.reduce((sum, row) => ({
          requests: sum.requests + row.requests,
          children: sum.children + row.subagents,
          cost: sum.cost + row.costTotal,
          unpriced: sum.unpriced + row.unpricedRequests
        }), { requests: 0, children: 0, cost: 0, unpriced: 0 });
        lines.push(sectionHeading(ctx, w, "Root sessions", "all recorded dates", true));
        lines.push(...metricGrid(ctx, w, [
          { label: "Sessions", value: sessionsLoaded ? formatInteger(all.length) : "\u2013", hint: sessionsLoaded ? `${sessions.length} fetched candidates` : "recorded candidates pending", emphasis: "primary" },
          { label: "Requests", value: sessionsLoaded ? formatInteger(totals.requests) : "\u2013", hint: sessionsLoaded ? `${totals.children} children included` : "waiting for recorded totals" },
          { label: "Cost", value: sessionsLoaded ? costWithUnpriced(totals.cost, totals.unpriced) : "\u2013", hint: "matching candidates only" }
        ]));
        hint(`\u2191/\u2193 select \xB7 Enter open \xB7 / search \xB7 o sort \xB7 D reverse \xB7 l reveal \xB7 + fetch \xB7 y copy \xB7 u refresh`);
        hint(`At most 300 recent root candidates \xB7 ${Math.min(revealed, all.length)} revealed \xB7 ${all.length} matching \xB7 ${listSort} ${listDescending ? "\u2193" : "\u2191"}`);
        if (listSearch)
          add(`Filter: ${clean(listSearch)} \xB7 x clear`);
        const window = localWindow(shown, Math.max(0, index), Math.max(3, height - lines.length - 6));
        lines.push(...dataTable(ctx, w, "", [
          { key: "identity", header: "Session", align: "left" },
          { key: "requests", header: "Req", align: "right" },
          { key: "duration", header: "Wall", align: "right", priority: 1 },
          { key: "cost", header: "Cost", align: "right", priority: 2 },
          { key: "children", header: "Child", align: "right", priority: 3 }
        ], window.rows.map((row) => ({
          identity: sessionIdentity(row.title, row.file, row.folder),
          requests: formatInteger(row.requests),
          duration: formatDurationMs(row.endedAt - row.startedAt),
          cost: costWithUnpriced(row.costTotal, row.unpricedRequests),
          children: formatInteger(row.subagents)
        })), index - window.offset));
        const selected = all.find((row) => row.file === sessionSelected);
        if (selected) {
          add(ctx.theme.fg("accent", clean(`Session: ${sessionIdentity(selected.title, selected.file, selected.folder)}`)));
          hint(clean(`${selected.folder} \xB7 ${selected.models.join(", ") || "no recorded models"}`));
          hint(clean(`${selected.toolCalls} tools \xB7 ${formatInteger(selected.totalTokens)} tokens \xB7 ${selected.unpricedRequests} unpriced \xB7 ${new Date(selected.startedAt).toISOString()}`));
          hint(clean(`File: ${selected.file}`));
        }
        if (!all.length && !loading && !error)
          add(listSearch ? "No matching sessions; x clears the search." : "No indexed root sessions; s syncs recorded transcripts.");
        return bounded(lines, w);
      }
      lines.push(sectionHeading(ctx, w, sessionIdentity(state.trace?.title, state.file, state.trace?.cwd), history.length ? `nested ${history.length} \xB7 b back` : "b back", true));
      const trace = state.trace;
      if (!trace)
        return bounded(lines, w);
      const summary = trace.summary;
      lines.push(...metricGrid(ctx, w, [
        { label: "Wall time", value: formatDurationMs(summary.wallMs), hint: `${summary.turns} turns \xB7 ${summary.subagents} agents`, emphasis: "primary" },
        { label: "Requests", value: formatInteger(summary.requests), hint: `${summary.toolCalls} tools \xB7 ${formatInteger(summary.totalTokens)} tok` },
        { label: "Cost", value: formatEstimatedCost(summary.costTotal, summary.unpricedRequests), hint: `${summary.unpricedRequests} unpriced` }
      ]));
      hint(`Model ${formatDurationMs(summary.modelMs)} \xB7 Tool ${formatDurationMs(summary.toolMs)} \xB7 Idle ${formatDurationMs(summary.idleMs)}`);
      lines.push(...focusTabs(ctx, w, ["Timeline", "Events", "Tools", "Tracks", "Minimap"], FOCI.indexOf(state.focus)));
      const selected = selectedRow();
      if (selected)
        add(ctx.theme.bold(ctx.theme.fg(selected.span?.isError ? "error" : "accent", clean(`Selected: ${rowLabel(selected, trace.startedAt)}`))));
      if (state.search || state.toolFilter)
        add(`Search: ${clean(state.search) || "all"} \xB7 ${rows().filter((row) => row.span).length} spans \xB7 Tool: ${clean(state.toolFilter) || "all"} \xB7 x clear`);
      if (detail && (selected || unmappedTarget)) {
        hint("Esc trace \xB7 j raw JSON \xB7 y copy \xB7 o child \xB7 O child file");
        if (unmappedTarget)
          add(clean(`Journal entry ${unmappedTarget.id} \xB7 ${unmappedTarget.file} \xB7 no recorded span timing`));
        lines.push(...renderEntry(unmappedTarget ? null : selected ?? null, entry, entryLoading, entryError, raw, w));
        return bounded(lines, w);
      }
      if (state.focus === "timeline" || state.focus === "minimap") {
        timelinePlotWidth = Math.max(1, w - Math.min(22, Math.max(4, Math.floor(w * 0.27))) - 1);
        hint(state.focus === "minimap" ? w < 60 ? "\u2190/\u2192 seek \xB7 Space anchor \xB7 Enter apply \xB7 m back" : "\u2190/\u2192 seek \xB7 Space anchor \xB7 Enter apply \xB7 h/l edges \xB7 a/d brush \xB7 +/- zoom \xB7 m timeline" : w < 60 ? "\u2191/\u2193 select \xB7 Space pick \xB7 Enter inspect \xB7 Tab panes" : `Tab panes \xB7 / search \xB7 n/N matches \xB7 +/- zoom \xB7 \u2190/\u2192 pan \xB7 Space pick \xB7 f focus \xB7 m minimap \xB7 v ${state.mode} \xB7 i idle ${state.compress ? "compressed" : "real"}`);
        if (state.focus === "minimap")
          hint(`Overview ${(state.overviewCursor * 100).toFixed(0)}%${state.overviewAnchor === null ? "" : ` \xB7 anchor ${(state.overviewAnchor * 100).toFixed(0)}%`}`);
        lines.push(...renderTimeline({
          trace,
          scale: state.scale,
          viewport: state.viewport,
          collapsed: state.collapsed,
          selected: state.selected,
          cursor: state.cursor,
          width: w,
          height: Math.max(8, height - lines.length),
          search: state.search,
          theme: ctx.theme,
          overviewCursor: state.focus === "minimap" ? state.overviewCursor : null,
          overviewAnchor: state.overviewAnchor
        }));
      } else if (state.focus === "transcript") {
        const all = rows(), index = all.findIndex((row) => row.key === state?.selected);
        const window = localWindow(all, Math.max(0, index), Math.max(3, height - lines.length - 3));
        hint(`${all.length} linked events + markers \xB7 / search \xB7 n/N matches \xB7 Enter inspect \xB7 o child`);
        lines.push(...dataTable(ctx, w, "", [
          { key: "event", header: "Event", align: "left" },
          { key: "at", header: "At", align: "right" },
          { key: "duration", header: "Wall", align: "right", priority: 1 },
          { key: "track", header: "Track", align: "left", priority: 2 }
        ], window.rows.map((row) => ({
          event: ctx.theme.fg(row.span?.isError ? "error" : row.span ? SPAN_COLORS[row.span.kind] : "muted", clean(`${row.span?.isError ? "ERROR \xB7 " : ""}${row.span?.label ?? row.marker?.label}${row.span?.unterminated ? " \xB7 pending" : ""}`)),
          at: `+${formatDurationMs(row.time - trace.startedAt)}`,
          duration: row.span ? formatDurationMs(row.span.end - row.span.start) : "\u2013",
          track: clean(row.track.id)
        })), index - window.offset));
        if (!all.length)
          add("No matching transcript events.");
      } else if (state.focus === "tools") {
        const tools = sortedTools();
        if (!tools.some((tool) => tool.tool === state?.toolSelected))
          state.toolSelected = tools[0]?.tool ?? null;
        const index = tools.findIndex((tool) => tool.tool === state?.toolSelected);
        const window = localWindow(tools, index, Math.max(3, height - lines.length - 6));
        hint(`Per-tool duration \xB7 ${toolSort} ${toolDescending ? "\u2193" : "\u2191"} \xB7 o sort \xB7 D reverse \xB7 Enter linked calls`);
        lines.push(...dataTable(ctx, w, "", [
          { key: "tool", header: "Tool", align: "left" },
          { key: "total", header: "Total", align: "right" },
          { key: "calls", header: "Calls", align: "right", priority: 1 },
          { key: "errors", header: "Errors", align: "right", priority: 2 },
          { key: "average", header: "Avg", align: "right", priority: 3 },
          { key: "max", header: "Max", align: "right", priority: 4 }
        ], window.rows.map((tool) => ({
          tool: clean(tool.tool),
          total: formatDurationMs(tool.totalMs),
          calls: formatInteger(tool.calls),
          errors: formatInteger(tool.errors),
          average: formatDurationMs(tool.calls ? tool.totalMs / tool.calls : 0),
          max: formatDurationMs(tool.maxMs)
        })), index - window.offset));
        const tool = tools[index];
        if (tool)
          add(clean(`${tool.tool} \xB7 ${tool.calls} calls \xB7 ${tool.errors} errors \xB7 avg ${formatDurationMs(tool.calls ? tool.totalMs / tool.calls : 0)} \xB7 max ${formatDurationMs(tool.maxMs)}`));
        if (!tools.length)
          add("No recorded tool calls.");
      } else {
        const tracks = trace.tracks;
        if (!tracks.some((track) => track.id === state?.childSelected))
          state.childSelected = tracks.find((track) => track.parentId)?.id ?? tracks[0]?.id ?? null;
        const index = tracks.findIndex((track) => track.id === state?.childSelected);
        const window = localWindow(tracks, index, Math.max(3, height - lines.length - 6));
        hint("Track tree \xB7 \u2191/\u2193 select \xB7 Enter reveal \xB7 O transcript \xB7 c collapse");
        lines.push(...dataTable(ctx, w, "", [
          { key: "track", header: "Track", align: "left" },
          { key: "requests", header: "Req", align: "right" },
          { key: "tools", header: "Tools", align: "right", priority: 1 },
          { key: "time", header: "Span sum", align: "right", priority: 2 }
        ], window.rows.map((track) => ({
          track: clean(`${"  ".repeat(ancestors(tracks, track.id).length)}${state.collapsed.has(track.id) ? "+" : "\u2212"} ${track.label || track.id} [${track.id}]`),
          requests: formatInteger(track.spans.filter((span) => span.kind === "model").length),
          tools: formatInteger(track.spans.filter((span) => span.kind === "tool").length),
          time: formatDurationMs(track.spans.reduce((sum, span) => sum + span.end - span.start, 0))
        })), index - window.offset));
        const track = tracks[index];
        if (track) {
          add(clean(`Agent: ${track.agent ?? "main"} \xB7 Model: ${track.model ?? "unknown"} \xB7 ${track.spans.filter((span) => span.isError).length} failed spans \xB7 ${track.markers.length} markers`));
          hint(clean(`File: ${track.file}`));
        }
      }
      return bounded(lines, w);
    },
    handleInput(data) {
      if (closed || !editing && (data === "q" || data === "[" || data === "]") || data === "\x0E" || data === "\x10")
        return false;
      if (editing) {
        if (matchesKey(data, "escape")) {
          editing = null;
          changed();
          return true;
        }
        if (matchesKey(data, "enter")) {
          if (editing === "sessions") {
            listSearch = draft.trim();
            revealed = 50;
            sessionSelected = null;
            editing = null;
            loadSessions();
          } else {
            if (state) {
              state.search = draft.trim();
              state.toolFilter = null;
            }
            editing = null;
            cycleMatch(1);
          }
          return true;
        }
        if (matchesKey(data, "backspace"))
          draft = Array.from(draft).slice(0, -1).join("");
        else if (data === "\x15")
          draft = "";
        else if (!/[\x00-\x1f\x7f]/.test(data))
          draft += clean(data);
        else
          return false;
        changed();
        return true;
      }
      if (data === "r" || data === "R" || data === "s")
        return false;
      if (data === "/") {
        editing = state ? "spans" : "sessions";
        draft = state?.search ?? listSearch;
        changed();
        return true;
      }
      if (data === "u") {
        if (state)
          loadTrace(state);
        else
          loadSessions();
        return true;
      }
      if (data === "y") {
        copySelection();
        return true;
      }
      if (!state) {
        const all = sortedSessions().slice(0, revealed);
        if (matchesKey(data, "up") || matchesKey(data, "down")) {
          const index = all.findIndex((row) => row.file === sessionSelected);
          sessionSelected = all[Math.max(0, Math.min(all.length - 1, index + (matchesKey(data, "up") ? -1 : 1)))]?.file ?? null;
        } else if (matchesKey(data, "enter")) {
          if (sessionSelected)
            openTrace(sessionSelected);
        } else if (data === "o")
          listSort = SESSION_SORTS[(SESSION_SORTS.indexOf(listSort) + 1) % SESSION_SORTS.length];
        else if (data === "D")
          listDescending = !listDescending;
        else if (data === "l")
          revealed += 50;
        else if (data === "+" || data === "=") {
          listLimit = 300;
          revealed = listLimit;
          loadSessions();
        } else if (data === "x") {
          listSearch = "";
          loadSessions();
        } else
          return false;
        changed();
        return true;
      }
      if (matchesKey(data, "escape")) {
        if (detail) {
          detail = false;
          resetEntry();
          unmappedTarget = null;
        } else if (state.focus === "minimap" && state.overviewAnchor !== null)
          state.overviewAnchor = null;
        else if (state.search || state.toolFilter) {
          state.search = "";
          state.toolFilter = null;
        } else
          back();
        changed();
        return true;
      }
      if (data === "b") {
        back();
        return true;
      }
      if (data === "x") {
        state.search = "";
        state.toolFilter = null;
        changed();
        return true;
      }
      if (data === "n" || data === "N") {
        cycleMatch(data === "n" ? 1 : -1);
        return true;
      }
      if (data === "o" && (detail || state.focus !== "tools")) {
        childAction(false);
        return true;
      }
      if (data === "O") {
        childAction(true);
        return true;
      }
      if (detail) {
        if (data === "j") {
          raw = !raw;
          changed();
          return true;
        }
        return false;
      }
      if (matchesKey(data, "tab") || data === "\x1B[Z") {
        const direction = data === "\x1B[Z" ? -1 : 1;
        state.focus = FOCI[(FOCI.indexOf(state.focus) + direction + FOCI.length) % FOCI.length];
        changed();
        return true;
      }
      if (data === "m") {
        if (state.focus === "minimap") {
          state.focus = "timeline";
          state.overviewAnchor = null;
        } else {
          state.focus = "minimap";
          const [start, end] = state.scale.domain;
          state.overviewCursor = ((state.viewport.u0 + state.viewport.u1) / 2 - start) / (end - start);
        }
        changed();
        return true;
      }
      if (state.focus === "minimap") {
        if (matchesKey(data, "left") || matchesKey(data, "right"))
          state.overviewCursor = Math.max(0, Math.min(1, state.overviewCursor + (matchesKey(data, "left") ? -0.05 : 0.05)));
        else if (matchesKey(data, "home") || matchesKey(data, "end"))
          state.overviewCursor = matchesKey(data, "home") ? 0 : 1;
        else if (data === " ")
          state.overviewAnchor = state.overviewCursor;
        else if (matchesKey(data, "enter")) {
          state.viewport = overviewViewport(state.scale, state.viewport, state.overviewCursor, state.overviewAnchor);
          state.overviewAnchor = null;
        } else if (data === "h" || data === "l")
          state.viewport = resizeOverview(state.scale, state.viewport, state.overviewCursor, data === "h" ? "start" : "end");
        else if (data === "a" || data === "d") {
          const [start, end] = state.scale.domain;
          const shift = (end - start) * (data === "a" ? -0.05 : 0.05);
          state.viewport = clampViewport(state.scale, { u0: state.viewport.u0 + shift, u1: state.viewport.u1 + shift });
        } else if (data === "+" || data === "=" || data === "-")
          state.viewport = zoomViewport(state.scale, state.viewport, data === "-" ? 1.5 : 1 / 1.5, 0.5);
        else if (data === "0") {
          state.viewport = fit(state.scale);
          state.overviewAnchor = null;
        } else if (data === "v") {
          const modes = ["time", "turns", "calls"];
          changeAxis(modes[(modes.indexOf(state.mode) + 1) % modes.length], state.compress);
          return true;
        } else if (data === "i") {
          changeAxis(state.mode, !state.compress);
          return true;
        } else
          return false;
        changed();
        return true;
      }
      if (data === "c" || data === "C" || data === "E") {
        if (data === "E")
          state.collapsed.clear();
        else if (data === "C")
          state.collapsed = new Set(state.trace?.tracks.filter((track) => track.parentId).map((track) => track.id));
        else {
          const id = state.focus === "children" ? state.childSelected : selectedRow()?.track.id;
          if (id) {
            if (state.collapsed.has(id))
              state.collapsed.delete(id);
            else
              state.collapsed.add(id);
          }
        }
        changed();
        return true;
      }
      if (matchesKey(data, "up") || matchesKey(data, "down")) {
        const direction = matchesKey(data, "up") ? -1 : 1;
        if (state.focus === "tools") {
          const tools = sortedTools(), index = tools.findIndex((tool) => tool.tool === state?.toolSelected);
          state.toolSelected = tools[Math.max(0, Math.min(tools.length - 1, index + direction))]?.tool ?? null;
        } else if (state.focus === "children") {
          const tracks = state.trace?.tracks ?? [], index = tracks.findIndex((track) => track.id === state?.childSelected);
          state.childSelected = tracks[Math.max(0, Math.min(tracks.length - 1, index + direction))]?.id ?? null;
        } else {
          const all = rows(), index = all.findIndex((row) => row.key === state?.selected);
          const next = all[Math.max(0, Math.min(all.length - 1, index + direction))];
          if (next)
            select(next);
        }
        changed();
        return true;
      }
      if (matchesKey(data, "enter")) {
        if (state.focus === "tools") {
          state.toolFilter = state.toolSelected ?? sortedTools()[0]?.tool ?? null;
          state.search = "";
          state.focus = "transcript";
          const first = rows()[0];
          if (first)
            select(first);
        } else if (state.focus === "children")
          childAction(false);
        else {
          const selected = selectedRow();
          if (selected)
            select(selected, true);
        }
        changed();
        return true;
      }
      if (state.focus === "tools") {
        if (data === "o")
          toolSort = TOOL_SORTS[(TOOL_SORTS.indexOf(toolSort) + 1) % TOOL_SORTS.length];
        else if (data === "D")
          toolDescending = !toolDescending;
        else
          return false;
        changed();
        return true;
      }
      if (state.focus !== "timeline")
        return false;
      if (data === "v") {
        const modes = ["time", "turns", "calls"];
        changeAxis(modes[(modes.indexOf(state.mode) + 1) % modes.length], state.compress);
        return true;
      }
      if (data === "i") {
        changeAxis(state.mode, !state.compress);
        return true;
      }
      if (data === "+" || data === "=" || data === "w" || data === "-" || data === "S")
        state.viewport = zoomViewport(state.scale, state.viewport, data === "-" || data === "S" ? 1.5 : 1 / 1.5, state.cursor);
      else if (matchesKey(data, "left") || matchesKey(data, "right") || data === "a" || data === "d") {
        const shift = (state.viewport.u1 - state.viewport.u0) * 0.2 * (matchesKey(data, "left") || data === "a" ? -1 : 1);
        state.viewport = clampViewport(state.scale, { u0: state.viewport.u0 + shift, u1: state.viewport.u1 + shift });
      } else if (data === "h" || data === "l")
        state.cursor = Math.max(0, Math.min(1, state.cursor + (data === "h" ? -0.05 : 0.05)));
      else if (data === "0")
        state.viewport = fit(state.scale);
      else if (data === "f") {
        const selected = selectedRow();
        if (selected?.span)
          state.viewport = revealSpan(state.scale, state.viewport, selected.span, true);
      } else if (data === " ") {
        const x = Math.min(timelinePlotWidth - 1, Math.floor(state.cursor * (timelinePlotWidth - 1)));
        const track = selectedRow()?.track.id;
        const visible = new Set(visibleTracks(state.trace?.tracks ?? [], state.collapsed).map((item) => item.id));
        const candidates = rows().filter((row) => {
          if (!visible.has(row.track.id))
            return false;
          if (row.span) {
            const bounds = spanCells(state.scale, state.viewport, row.span, timelinePlotWidth);
            return !!bounds && x >= bounds[0] && x < bounds[1];
          }
          const u = state.scale.toU(row.time);
          return u >= state.viewport.u0 && u <= state.viewport.u1 && Math.min(timelinePlotWidth - 1, Math.floor((u - state.viewport.u0) / (state.viewport.u1 - state.viewport.u0) * timelinePlotWidth)) === x;
        });
        const selected = candidates.find((row) => row.track.id === track) ?? candidates[0];
        if (selected)
          select(selected);
        else {
          notice = "No event under the keyboard cursor; \u2191/\u2193 selects neighbouring events.";
        }
      } else
        return false;
      changed();
      return true;
    }
  };
}

// src/tui/features/frustration.ts
import { truncateToWidth as truncateToWidth11, wrapTextWithAnsi as wrapTextWithAnsi8 } from "@oh-my-pi/pi-tui";

// src/tui/features/frustration-data.ts
var MIN_MESSAGES = 50;
var MIN_JUDGED_SHARE = 0.5;
var FRUSTRATION_SORTS = ["version", "label", "messages", "judged", "annoyed", "atAssistant", "angry"];
function familyKey(row) {
  return `${row.modelClass}/${row.family ?? "unclassified"}`;
}
function fraction(part, whole) {
  return whole > 0 ? part / whole : 0;
}
function mostlyRegex(row) {
  return row.messages > 0 && fraction(row.judged, row.messages) < MIN_JUDGED_SHARE;
}
function layerFraction(row, layer) {
  const count = layer === "angry" ? row.angry : layer === "assistant" ? row.atAssistant - row.angry : row.annoyed - row.atAssistant;
  return fraction(count, row.messages);
}
function classTotals(models) {
  const totals = new Map;
  for (const row of models)
    totals.set(row.modelClass, (totals.get(row.modelClass) ?? 0) + row.messages);
  return totals;
}
function activeModelClass(models, selected) {
  const totals = classTotals(models);
  if (selected === "*" || selected !== null && totals.has(selected))
    return selected;
  let best = "*";
  let messages = -1;
  for (const [key, count] of totals)
    if (count > messages) {
      best = key;
      messages = count;
    }
  return best;
}
function filterFrustrationRows(models, filters) {
  const active = activeModelClass(models, filters.modelClass);
  return models.filter((row) => (active === "*" || row.modelClass === active) && !filters.hiddenFamilies.has(familyKey(row)) && (filters.showSmall || row.messages >= MIN_MESSAGES) && !(filters.hideRegex && mostlyRegex(row)));
}
function sortFrustrationRows(rows, sort, descending) {
  if (sort === "version")
    return descending ? [...rows].reverse() : [...rows];
  return [...rows].sort((a, b) => {
    const compare = sort === "label" ? a.label.localeCompare(b.label) : sort === "messages" ? a.messages - b.messages : fraction(a[sort], a.messages) - fraction(b[sort], b.messages);
    return (descending ? -compare : compare) || a.key.localeCompare(b.key);
  });
}

// src/tui/features/frustration.ts
var ACTION_OPTIONS = { method: "POST", headers: { "X-Omp-Stats-Action": "1" } };
var LAYERS = ["angry", "assistant", "other"];
var LAYER_LABELS = { angry: "Angry at assistant", assistant: "At assistant, not angry", other: "Annoyed at other targets" };
function createFrustrationFeature(ctx) {
  let range = "24h";
  let data;
  let dataRange;
  let job;
  let error;
  let actionError;
  let copyNotice;
  let loading = false;
  let disposed = false;
  let readGeneration = 0;
  let quoteGeneration = 0;
  let actionGeneration = 0;
  let timer;
  let quote = { state: "closed" };
  let starting = false;
  let cancelling = false;
  let modelClass = null;
  const hiddenFamilies = new Set;
  let familyCursor = 0;
  let showSmall = false;
  let hideRegex = false;
  const hiddenLayers = new Set;
  let trend = true;
  let sort = "version";
  let descending = false;
  let selectedKey;
  let selectedIndex = 0;
  let revealed = 20;
  let details = false;
  let focus = "versions";
  function stopPoll() {
    clearTimeout(timer);
    timer = undefined;
  }
  function schedulePoll() {
    stopPoll();
    if (!disposed && job?.state === "running") {
      timer = setTimeout(() => {
        timer = undefined;
        readStats();
      }, 1000);
    }
  }
  async function readStats() {
    if (disposed)
      return;
    const generation = ++readGeneration;
    const requestedRange = range;
    loading = true;
    ctx.changed();
    try {
      const result = await ctx.reader.api("/api/stats/frustration", { range: requestedRange });
      if (disposed || generation !== readGeneration)
        return;
      if (!result || !result.overall || !Array.isArray(result.byModel) || !result.job) {
        error = "Frustration payload missing overall/byModel/job";
        job = undefined;
        return;
      }
      data = result;
      dataRange = requestedRange;
      job = result.job;
      if (job.state === "running" && !starting && quote.state !== "closed") {
        quote = { state: "closed" };
        ++quoteGeneration;
      }
      error = undefined;
    } catch (err) {
      if (disposed || generation !== readGeneration)
        return;
      error = err instanceof Error ? err.message : String(err);
    } finally {
      if (!disposed && generation === readGeneration) {
        loading = false;
        schedulePoll();
        ctx.changed();
      }
    }
  }
  async function openQuote() {
    if (disposed || starting || cancelling || job?.state === "running")
      return;
    const generation = ++quoteGeneration;
    const quotedRange = range;
    quote = { state: "loading", range: quotedRange };
    actionError = undefined;
    ctx.changed();
    try {
      const estimate = await ctx.reader.api("/api/frustration/estimate", { range: quotedRange });
      if (disposed || generation !== quoteGeneration)
        return;
      quote = { state: "ready", range: quotedRange, estimate };
    } catch (err) {
      if (disposed || generation !== quoteGeneration)
        return;
      quote = { state: "error", range: quotedRange, error: err instanceof Error ? err.message : String(err) };
    }
    if (!disposed)
      ctx.changed();
  }
  async function startRun() {
    if (disposed || starting || cancelling || quote.state !== "ready" || !quote.estimate.available || quote.estimate.messages === 0 || job?.state === "running")
      return;
    const quotedRange = quote.range;
    const generation = ++actionGeneration;
    starting = true;
    actionError = undefined;
    ++readGeneration;
    loading = false;
    stopPoll();
    ctx.changed();
    try {
      const startedJob = await ctx.reader.api("/api/frustration/judge", { range: quotedRange }, ACTION_OPTIONS);
      if (disposed) {
        if (startedJob.state === "running")
          await ctx.reader.api("/api/frustration/cancel", undefined, ACTION_OPTIONS).catch(() => {
            return;
          });
        return;
      }
      if (generation !== actionGeneration)
        return;
      job = startedJob;
      starting = false;
      quote = { state: "closed" };
      ++quoteGeneration;
      await readStats();
    } catch (err) {
      if (!disposed && generation === actionGeneration)
        actionError = err instanceof Error ? err.message : String(err);
    } finally {
      if (!disposed && generation === actionGeneration) {
        starting = false;
        schedulePoll();
        ctx.changed();
      }
    }
  }
  async function cancelRun() {
    if (disposed || starting || cancelling || job?.state !== "running")
      return;
    const generation = ++actionGeneration;
    cancelling = true;
    actionError = undefined;
    ++readGeneration;
    loading = false;
    stopPoll();
    ctx.changed();
    try {
      const cancelledJob = await ctx.reader.api("/api/frustration/cancel", undefined, ACTION_OPTIONS);
      if (disposed || generation !== actionGeneration)
        return;
      job = cancelledJob;
      await readStats();
    } catch (err) {
      if (!disposed && generation === actionGeneration)
        actionError = err instanceof Error ? err.message : String(err);
    } finally {
      if (!disposed && generation === actionGeneration) {
        cancelling = false;
        schedulePoll();
        ctx.changed();
      }
    }
  }
  function population() {
    const models = data?.byModel ?? [];
    const active = activeModelClass(models, modelClass);
    const inClass = models.filter((row) => active === "*" || row.modelClass === active);
    const familyMessages = new Map;
    for (const row of inClass)
      familyMessages.set(familyKey(row), (familyMessages.get(familyKey(row)) ?? 0) + row.messages);
    const families = [...familyMessages.keys()];
    const visibleFamilies = inClass.filter((row) => !hiddenFamilies.has(familyKey(row)));
    const smallCount = visibleFamilies.filter((row) => row.messages < MIN_MESSAGES).length;
    const regexCount = visibleFamilies.filter(mostlyRegex).length;
    const chartRows = filterFrustrationRows(models, { modelClass, hiddenFamilies, showSmall, hideRegex });
    const rows = sortFrustrationRows(chartRows, sort, descending);
    const rememberedIndex = rows.findIndex((row) => row.key === selectedKey);
    selectedIndex = rememberedIndex >= 0 ? rememberedIndex : Math.min(selectedIndex, Math.max(0, rows.length - 1));
    selectedKey = rows[selectedIndex]?.key;
    revealed = Math.max(revealed, selectedIndex + 1);
    familyCursor = Math.min(familyCursor, Math.max(0, families.length - 1));
    return { active, families, familyMessages, smallCount, regexCount, chartRows, rows };
  }
  return {
    async load(nextRange) {
      if (disposed)
        return;
      if (range !== nextRange) {
        range = nextRange;
        quote = { state: "closed" };
        ++quoteGeneration;
      }
      stopPoll();
      await readStats();
    },
    render(width, height) {
      const w = Math.max(1, Math.floor(width));
      const lines = [];
      const add = (text) => {
        lines.push(...wrapTextWithAnsi8(text, w));
      };
      const fg = ctx.theme.fg.bind(ctx.theme);
      const rate = (part, whole) => whole > 0 ? formatPercent2(fraction(part, whole)) : "\u2013";
      if (quote.state !== "closed") {
        lines.push(sectionHeading(ctx, w, "CLASSIFY WITH JUDGE", `quoted ${quote.range}`, true));
        if (quote.state === "loading")
          add("Loading prerequisites and cost quote\u2026 Nothing has been spent.");
        else if (quote.state === "error")
          add(fg("error", quote.error));
        else if (!quote.estimate.available)
          add(fg("warning", quote.estimate.reason));
        else {
          const estimate = quote.estimate;
          add(`Judge ${estimate.judge}`);
          add(`${formatInteger2(estimate.messages)} unique unjudged messages \xB7 ${formatInteger2(estimate.chars)} prose characters`);
          add(`Estimated input ${formatInteger2(estimate.inputTokens)} tokens \xB7 cost \u2248 ${formatCost2(estimate.cost)}`);
          add("Adaptive concurrency \xB7 identical messages share cached verdicts.");
          add(fg("warning", "Estimate \u2260 spending cap; retries can cost more."));
          add(estimate.messages === 0 ? "Everything in this range is already judged; nothing to classify." : fg("warning", starting ? "Starting the confirmed run\u2026" : "Press y to confirm paid judging. Enter does NOT spend. Esc/n backs out; q closes."));
        }
        if (actionError)
          add(fg("error", actionError));
        add("Esc/n dismiss \xB7 q close");
        return lines;
      }
      lines.push(sectionHeading(ctx, w, "Frustration", `${range} \xB7 passive cache`, true));
      if (data) {
        const overall = data.overall;
        lines.push(...metricGrid(ctx, w, [
          { label: "User messages", value: formatInteger2(overall.messages), hint: `annoyed ${rate(overall.annoyed, overall.messages)}`, emphasis: "primary" },
          { label: "At assistant", value: rate(overall.atAssistant, overall.messages), hint: `angry ${rate(overall.angry, overall.messages)}` },
          { label: "Judge coverage", value: rate(overall.judged, overall.messages), hint: `regex ${formatInteger2(overall.messages - overall.judged)}` }
        ]));
      }
      if (loading)
        add(fg("dim", data ? "Refreshing cached metrics\u2026" : "Loading cached metrics\u2026"));
      if (error)
        add(fg("error", `${data ? "Cached data retained; refresh failed: " : "Unable to read metrics: "}${error}`));
      if (dataRange && dataRange !== range)
        add(fg("warning", `Stale ${dataRange} metrics \xB7 requested ${range}${loading ? " loading" : ""}`));
      if (job) {
        const elapsed = job.startedAt === null ? "" : ` \xB7 ${formatElapsed((job.finishedAt ?? ctx.now()) - job.startedAt)}`;
        add(fg(job.state === "failed" ? "error" : job.state === "running" ? "success" : "muted", `Judge ${job.state} \xB7 ${job.done}/${job.total} judged \xB7 ${job.failed} failed \xB7 ${formatCost2(job.cost)}${elapsed}`));
        if (job.state === "running") {
          const completed = Math.min(1, fraction(job.done + job.failed, job.total));
          const cells = Math.max(1, Math.min(20, w - 10));
          add(Array.from({ length: cells }, (_, i) => fg(i < completed * cells ? "success" : "dim", glyph(ctx.theme.getSymbolPreset(), i < completed * cells ? "barFill" : "barEmpty"))).join("") + ` ${formatPercent2(completed)}`);
          add(`${job.concurrency} in flight${job.startedAt !== null && job.done > 0 ? ` \xB7 ${(job.done / Math.max(1, (ctx.now() - job.startedAt) / 1000)).toFixed(1)}/s` : ""} \xB7 x ${cancelling ? "cancelling\u2026" : "cancel run"}${job.judge ? ` \xB7 ${job.judge}` : ""}`);
        } else
          add(fg("dim", `j quote/confirm paid classification${job.judge ? ` \xB7 ${job.judge}` : ""}`));
        if (job.error)
          add(fg("error", job.error));
      } else
        add(fg("dim", "j quote prerequisites \xB7 no paid calls on load"));
      if (data && !data.judgeAvailable)
        add(fg("warning", "Regex + cached verdicts \xB7 judge not registered \xB7 j prerequisites"));
      if (actionError)
        add(fg("error", actionError));
      if (copyNotice)
        add(fg("success", copyNotice));
      if (!data)
        return lines;
      const { active, families, familyMessages, smallCount, regexCount, chartRows, rows } = population();
      const selected = rows[selectedIndex];
      lines.push(...focusTabs(ctx, w, ["Versions", "Families"], focus === "versions" ? 0 : 1));
      add(fg("dim", w < 60 ? `Class ${active} [c] \xB7 ${showSmall ? "all samples" : "\u226550 msgs"} [m] \xB7 regex ${hideRegex ? "off" : "on"} [h]` : `Class ${active} [c] \xB7 ${showSmall ? "including" : "excluding"} <50 messages (${smallCount} versions) [m] \xB7 regex ${hideRegex ? "hidden" : "shown"} (${regexCount}) [h]`));
      add(fg("dim", focus === "families" ? "Tab versions \xB7 \u2191/\u2193 family \xB7 Space toggle" : w < 60 ? "\u2191/\u2193 select \xB7 Enter details \xB7 Tab families" : `\u2191/\u2193 version \xB7 Enter details \xB7 Tab families \xB7 o/O ${sort} ${descending ? "\u2193" : "\u2191"} \xB7 v reveal`));
      if (selected) {
        add(ctx.theme.bold(fg("accent", `Point ${selectedIndex + 1}/${rows.length}: ${selected.label} \xB7 ${formatInteger2(selected.messages)} messages${mostlyRegex(selected) ? " \xB7 mostly regex" : ""}`)));
        add(w < 60 ? `assistant ${rate(selected.atAssistant, selected.messages)} \xB7 judged ${rate(selected.judged, selected.messages)}` : `Judged ${rate(selected.judged, selected.messages)} \xB7 annoyed ${rate(selected.annoyed, selected.messages)} \xB7 assistant ${rate(selected.atAssistant, selected.messages)} \xB7 angry ${rate(selected.angry, selected.messages)}`);
        if (details) {
          lines.push(sectionHeading(ctx, w, "Model detail", "Enter/Esc back \xB7 p copy JSON", true));
          add(`Identity ${selected.key} \xB7 class ${selected.modelClass} \xB7 family ${selected.family ?? "unclassified"} \xB7 revision ${selected.revision ?? "unclassified"}`);
          add(`Counts: judged ${selected.judged}; annoyed ${selected.annoyed}; assistant ${selected.atAssistant}; angry ${selected.angry}`);
          add(`Layers: angry ${rate(selected.angry, selected.messages)} \xB7 assistant-not-angry ${rate(selected.atAssistant - selected.angry, selected.messages)} \xB7 other ${rate(selected.annoyed - selected.atAssistant, selected.messages)}`);
          for (const id of selected.models)
            add(`Raw model ID: ${id}`);
          add(`First seen ${new Date(selected.firstSeen).toISOString()}`);
          return lines;
        }
      }
      const colors = resolveSeries(Math.max(1, families.length), ctx.theme);
      if (focus === "families") {
        const slots = Math.max(3, Math.min(10, height - lines.length - 3));
        const start = Math.max(0, Math.min(Math.max(0, families.length - slots), familyCursor - Math.floor(slots / 2)));
        lines.push(...dataTable(ctx, w, "Families", [
          { key: "family", header: "Family", align: "left" },
          { key: "messages", header: "Msgs", align: "right" },
          { key: "visible", header: "Shown", align: "right", priority: 1 }
        ], families.slice(start, start + slots).map((family, index) => ({
          family: fg(colors[(start + index) % colors.length], family),
          messages: formatInteger2(familyMessages.get(family) ?? 0),
          visible: hiddenFamilies.has(family) ? "off" : "on"
        })), familyCursor - start));
        add(fg("dim", `Class messages: ${[...classTotals(data.byModel)].map(([key, messages]) => `${key} ${formatInteger2(messages)}`).join(" \xB7 ")}`));
        if (!families.length)
          add("No model families in this range.");
        return lines;
      }
      if (!rows.length) {
        add(data.byModel.length ? "No model versions match the filters. c/m/h and family Space change filters." : "No user messages with prose in this range. Try a longer range.");
        return lines;
      }
      if (chartRows.every((row) => row.messages > 0 && row.annoyed === 0))
        add(fg("dim", "No frustrated messages for these models; all annoyance rates are zero."));
      lines.push(sectionHeading(ctx, w, "Rates by version", "catalog order \xB7 not time", true));
      const chartIndex = Math.max(0, chartRows.findIndex((row) => row.key === selectedKey));
      const slots = Math.max(1, Math.min(chartRows.length, Math.floor(Math.max(2, w - 9) / 2)));
      const chartStart = Math.max(0, Math.min(chartRows.length - slots, chartIndex - Math.floor(slots / 2)));
      const plot = chartRows.slice(chartStart, chartStart + slots);
      const barWidth = Math.max(1, Math.min(8, Math.floor((w - 9) / slots) - 1));
      const preset = ctx.theme.getSymbolPreset();
      const plotHeight = Math.max(3, Math.min(6, Math.floor(height / 6), height - lines.length - 8));
      const peak = Math.max(0.05, ...plot.map((row) => LAYERS.reduce((sum, layer) => sum + (hiddenLayers.has(layer) ? 0 : layerFraction(row, layer)), 0)), ...trend ? plot.map((row) => fraction(row.atAssistant, row.messages)) : []);
      for (let y = plotHeight - 1;y >= 0; y--) {
        const threshold = (y + 0.5) / plotHeight * peak;
        let marks = "";
        for (const [index, row] of plot.entries()) {
          if (row.messages === 0) {
            marks += fg("dim", y === 0 ? "\u2013" + " ".repeat(barWidth) : " ".repeat(barWidth + 1));
            continue;
          }
          let top = 0;
          let mark = " ";
          let layerToken = "muted";
          for (const layer of LAYERS) {
            if (hiddenLayers.has(layer))
              continue;
            top += layerFraction(row, layer);
            if (mark === " " && threshold <= top) {
              mark = glyph(preset, "barFill");
              layerToken = layer === "angry" ? "error" : layer === "assistant" ? "warning" : "muted";
            }
          }
          const familyIndex = families.indexOf(familyKey(row));
          if (mostlyRegex(row) && mark !== " " && y % 2 === 0)
            mark = "/";
          const trendY = Math.min(plotHeight - 1, Math.floor(fraction(row.atAssistant, row.messages) / peak * plotHeight));
          const middle = Math.floor(barWidth / 2);
          let cell = trend && y === trendY ? fg(layerToken, mark.repeat(middle)) + ctx.theme.bold(fg("text", "*")) + fg(layerToken, mark.repeat(barWidth - middle - 1)) : fg(layerToken, mark.repeat(barWidth));
          const next = plot[index + 1];
          const connectorY = next && next.messages > 0 ? Math.min(plotHeight - 1, Math.floor((fraction(row.atAssistant, row.messages) + fraction(next.atAssistant, next.messages)) / (2 * peak) * plotHeight)) : -1;
          cell += trend && y === connectorY ? fg("text", glyph(preset, "trendFlat")) : fg(colors[Math.max(0, familyIndex) % colors.length], row.key === selectedKey ? glyph(preset, "columnGap") : y === 0 ? glyph(preset, "heatEmpty") : " ");
          marks += row.key === selectedKey ? ctx.theme.bg(SELECTION_BG.band, cell) : cell;
        }
        lines.push(truncateToWidth11(`${formatPercent2((y + 1) / plotHeight * peak, 1).padStart(6)} ${glyph(preset, "columnGap")} ${marks}`, w));
      }
      lines.push(truncateToWidth11("  0.0%   " + plot.map((row) => " ".repeat(Math.floor(barWidth / 2)) + fg(row.key === selectedKey ? "accent" : "dim", glyph(preset, row.key === selectedKey ? "trendUp" : "heatEmpty")) + " ".repeat(barWidth - Math.floor(barWidth / 2))).join(""), w));
      add(fg("dim", `Versions ${chartStart + 1}\u2013${chartStart + plot.length}/${chartRows.length}: ${plot[0].label} \u2192 ${plot[plot.length - 1].label}`));
      add(LAYERS.map((layer, index) => fg(hiddenLayers.has(layer) ? "dim" : layer === "angry" ? "error" : layer === "assistant" ? "warning" : "muted", `${index + 1} ${hiddenLayers.has(layer) ? "off" : "on"} ${LAYER_LABELS[layer]}`)).join(" \xB7 ") + ` \xB7 4 trend ${trend ? "on" : "off"}`);
      const reachable = Math.min(rows.length, revealed);
      const pageSize = Math.max(3, Math.min(12, height - lines.length - 3));
      const tableStart = Math.max(0, Math.min(Math.max(0, reachable - pageSize), selectedIndex - Math.floor(pageSize / 2)));
      lines.push(...dataTable(ctx, w, "Versions", [
        { key: "identity", header: "Model version", align: "left" },
        { key: "assistant", header: "Assist", align: "right" },
        { key: "messages", header: "Msgs", align: "right", priority: 1 },
        { key: "angry", header: "Angry", align: "right", priority: 2 },
        { key: "judged", header: "Judged", align: "right", priority: 3 },
        { key: "annoyed", header: "Annoy", align: "right", priority: 4 }
      ], rows.slice(tableStart, Math.min(reachable, tableStart + pageSize)).map((row) => ({
        identity: `${row.label}${mostlyRegex(row) ? " /" : ""}`,
        assistant: rate(row.atAssistant, row.messages),
        messages: formatInteger2(row.messages),
        angry: rate(row.angry, row.messages),
        judged: rate(row.judged, row.messages),
        annoyed: rate(row.annoyed, row.messages)
      })), selectedIndex - tableStart));
      add(fg("dim", `${reachable}/${rows.length} revealed \xB7 ${families.length} families \xB7 / mostly regex \xB7 v more`));
      return lines;
    },
    handleInput(input) {
      if (disposed || input === "q")
        return false;
      if (quote.state !== "closed") {
        if (input === "\x1B" || input === "n") {
          if (!starting) {
            quote = { state: "closed" };
            ++quoteGeneration;
            ctx.changed();
          }
        } else if (input === "y")
          startRun();
        return true;
      }
      const { families, rows } = population();
      if (input === "j") {
        openQuote();
        return true;
      }
      if (input === "x" && job?.state === "running") {
        cancelRun();
        return true;
      }
      if (input === "\t")
        focus = focus === "versions" ? "families" : "versions";
      else if (input === "c") {
        const options = ["*", ...classTotals(data?.byModel ?? []).keys()];
        modelClass = options[(options.indexOf(activeModelClass(data?.byModel ?? [], modelClass)) + 1) % options.length];
        selectedIndex = 0;
        selectedKey = undefined;
      } else if (input === "m")
        showSmall = !showSmall;
      else if (input === "h")
        hideRegex = !hideRegex;
      else if (input === "o")
        sort = FRUSTRATION_SORTS[(FRUSTRATION_SORTS.indexOf(sort) + 1) % FRUSTRATION_SORTS.length];
      else if (input === "O")
        descending = !descending;
      else if (input === "v")
        revealed = Math.min(rows.length, Math.max(20, revealed * 2));
      else if (input === "1" || input === "2" || input === "3") {
        const layer = LAYERS[Number(input) - 1];
        if (hiddenLayers.has(layer))
          hiddenLayers.delete(layer);
        else
          hiddenLayers.add(layer);
      } else if (input === "4")
        trend = !trend;
      else if (input === " " && focus === "families" && families[familyCursor]) {
        const key = families[familyCursor];
        if (hiddenFamilies.has(key))
          hiddenFamilies.delete(key);
        else
          hiddenFamilies.add(key);
      } else if (input === "\x1B[A" || input === "\x1B[B") {
        const delta = input === "\x1B[A" ? -1 : 1;
        if (focus === "families")
          familyCursor = Math.max(0, Math.min(families.length - 1, familyCursor + delta));
        else {
          selectedIndex = Math.max(0, Math.min(Math.min(rows.length, revealed) - 1, selectedIndex + delta));
          selectedKey = rows[selectedIndex]?.key;
        }
      } else if (input === "\r" || input === `
`)
        details = !details;
      else if (input === "\x1B" && details)
        details = false;
      else if (input === "p" && details && rows[selectedIndex]) {
        ctx.copy(JSON.stringify(rows[selectedIndex], null, 2)).then(() => {
          if (!disposed) {
            actionError = undefined;
            copyNotice = "Selected model row copied.";
            ctx.changed();
          }
        }, (err) => {
          if (!disposed) {
            copyNotice = undefined;
            actionError = `Clipboard failed: ${err instanceof Error ? err.message : String(err)}`;
            ctx.changed();
          }
        });
      } else
        return false;
      ctx.changed();
      return true;
    },
    dispose() {
      if (disposed)
        return;
      disposed = true;
      ++readGeneration;
      ++quoteGeneration;
      ++actionGeneration;
      stopPoll();
      if (job?.state === "running" || starting)
        ctx.reader.api("/api/frustration/cancel", undefined, ACTION_OPTIONS).catch(() => {
          return;
        });
    }
  };
}

// src/data/ranges.ts
var RANGES = ["1h", "24h", "7d", "30d", "90d", "all"];
var DEFAULT_RANGE = "24h";
function nextRange(current, direction) {
  const i = RANGES.indexOf(current);
  return RANGES[(i + direction + RANGES.length) % RANGES.length];
}

// src/tui/panel-constants.ts
var PANEL_CHROME_ROWS = 5;

// src/tui/layout.ts
var SIDE_INSET = 2;
var HORIZONTAL_INSET = SIDE_INSET * 2;
var BREAKPOINTS = [
  {
    name: "wide",
    minInnerWidth: 80,
    columns: 2,
    compact: false,
    tableColumns: 4,
    showFooterHints: true,
    dropped: []
  },
  {
    name: "medium",
    minInnerWidth: 44,
    columns: 1,
    compact: true,
    tableColumns: 3,
    showFooterHints: true,
    dropped: [
      { region: "secondColumn", reason: "inner width below 80 \u2014 two columns cannot both be legible" }
    ]
  },
  {
    name: "narrow",
    minInnerWidth: 30,
    columns: 1,
    compact: true,
    tableColumns: 2,
    showFooterHints: true,
    dropped: [
      { region: "secondColumn", reason: "inner width below 80 \u2014 two columns cannot both be legible" },
      { region: "wideTableColumns", reason: "inner width below 44 \u2014 tables keep two columns" }
    ]
  },
  {
    name: "tiny",
    minInnerWidth: 0,
    columns: 1,
    compact: true,
    tableColumns: 2,
    showFooterHints: false,
    dropped: [
      { region: "secondColumn", reason: "inner width below 80 \u2014 two columns cannot both be legible" },
      { region: "wideTableColumns", reason: "inner width below 44 \u2014 tables keep two columns" },
      { region: "footerHints", reason: "inner width below 30 \u2014 no room for a hint row beside content" }
    ]
  }
];
var MIN_USABLE_WIDTH = 20;
var LABEL_WIDTH = 12;
var VALUE_WIDTH = 12;
var PLAN_CACHE = new Map;
var PLAN_CACHE_LIMIT = 512;
function planLayout(width, rows, preset, bodyRows) {
  const key = `${width}\x00${rows}\x00${preset}\x00${bodyRows}`;
  const hit = PLAN_CACHE.get(key);
  if (hit !== undefined)
    return hit;
  const plan = computePlanLayout(width, rows, bodyRows);
  if (PLAN_CACHE.size >= PLAN_CACHE_LIMIT)
    PLAN_CACHE.clear();
  PLAN_CACHE.set(key, plan);
  return plan;
}
function computePlanLayout(width, rows, bodyRowsArg) {
  const safeWidth = Number.isFinite(width) ? Math.max(0, Math.trunc(width)) : 0;
  const safeRows = Number.isFinite(rows) ? Math.max(0, Math.trunc(rows)) : 0;
  const innerWidth = Math.max(0, safeWidth - HORIZONTAL_INSET);
  const bodyRows = Number.isFinite(bodyRowsArg) ? Math.max(1, Math.trunc(bodyRowsArg)) : 1;
  const overflowRows = Math.max(0, PANEL_CHROME_ROWS + 1 - safeRows);
  const breakpoint = BREAKPOINTS.find((row) => innerWidth >= row.minInnerWidth) ?? BREAKPOINTS[0];
  const columnWidth = breakpoint.columns === 2 ? Math.floor((innerWidth - SIDE_INSET) / 2) : innerWidth;
  const contentWidth = Math.max(0, columnWidth - SIDE_INSET * 2);
  const barFloor = Math.min(4, contentWidth);
  const labelWidth = Math.max(0, Math.min(LABEL_WIDTH, Math.floor((contentWidth - barFloor) / 3)));
  const valueWidth = Math.max(0, Math.min(VALUE_WIDTH, contentWidth - labelWidth - barFloor));
  const barWidth = contentWidth - labelWidth - valueWidth;
  const requestedBarHeight = breakpoint.compact ? breakpoint.minInnerWidth >= 44 ? 10 : 4 : 14;
  const barHeight = Math.max(1, Math.min(requestedBarHeight, bodyRows));
  const dropped = [...breakpoint.dropped];
  if (barHeight < requestedBarHeight) {
    dropped.push({
      region: "barHeight",
      reason: `body is ${bodyRows} rows \u2014 bar chart clamped from ${requestedBarHeight}`
    });
  }
  const heatWeeks = Math.max(4, Math.min(53, Math.floor((innerWidth - labelWidth) / 2)));
  const sparkWidth = breakpoint.minInnerWidth < 30 ? Math.min(8, innerWidth) : Math.max(0, Math.min(barWidth, innerWidth));
  return {
    width: safeWidth,
    requestedRows: safeRows,
    breakpoint: breakpoint.name,
    innerWidth,
    columnWidth,
    bodyRows,
    overflowRows,
    columns: breakpoint.columns,
    compact: breakpoint.compact,
    tableColumns: breakpoint.tableColumns,
    showFooterHints: breakpoint.showFooterHints,
    tooNarrow: safeWidth < MIN_USABLE_WIDTH,
    dropped,
    labelWidth,
    valueWidth,
    barWidth,
    barHeight,
    heatWeeks,
    sparkWidth
  };
}

// src/tui/screens/overview.ts
var overviewScreen = {
  id: "overview",
  label: "Overview",
  short: "Overview"
};

// src/tui/screens/activity.ts
var activityScreen = {
  id: "activity",
  label: "Activity",
  short: "Activity"
};

// src/tui/screens/models.ts
var modelsScreen = {
  id: "models",
  label: "Models",
  short: "Models"
};

// src/tui/screens/costs.ts
var costsScreen = {
  id: "costs",
  label: "Costs",
  short: "Costs"
};

// src/tui/screens/projects.ts
var projectsScreen = {
  id: "projects",
  label: "Projects",
  short: "Projects"
};

// src/tui/screens/requests.ts
var requestsScreen = {
  id: "requests",
  label: "Requests",
  short: "Requests"
};

// src/tui/screens/errors.ts
var errorsScreen = {
  id: "errors",
  label: "Errors",
  short: "Errors"
};

// src/tui/screens/tools.ts
var toolsScreen = {
  id: "tools",
  label: "Tools",
  short: "Tools"
};

// src/tui/screens/providers.ts
var providersScreen = {
  id: "providers",
  label: "Providers",
  short: "Provider"
};

// src/tui/screens/gain.ts
var gainScreen = {
  id: "gain",
  label: "Gain",
  short: "Gain"
};

// src/tui/screens/traces.ts
var tracesScreen = {
  id: "traces",
  label: "Traces",
  short: "Traces"
};

// src/tui/screens/frustration.ts
var frustrationScreen = {
  id: "frustration",
  label: "Frustration",
  short: "Frustr."
};

// src/tui/screens/types.ts
var SCREENS = Object.freeze([
  overviewScreen,
  activityScreen,
  modelsScreen,
  costsScreen,
  projectsScreen,
  requestsScreen,
  errorsScreen,
  toolsScreen,
  providersScreen,
  gainScreen,
  tracesScreen,
  frustrationScreen
]);
function screenById(id) {
  const screen = SCREENS.find((s) => s.id === id);
  if (!screen)
    throw new Error(`unknown screen id: ${String(id)}`);
  return screen;
}

// src/tui/chrome.ts
import { truncateToWidth as truncateToWidth12, visibleWidth as visibleWidth10 } from "@oh-my-pi/pi-tui";

// src/tui/responsive.ts
function framePolicy(width) {
  const safeWidth = Number.isFinite(width) ? Math.max(0, Math.trunc(width)) : 0;
  const innerWidth = Math.max(0, safeWidth - HORIZONTAL_INSET);
  const row = BREAKPOINTS.find((candidate) => innerWidth >= candidate.minInnerWidth) ?? BREAKPOINTS[0];
  const navMode = row.columns === 2 ? "sidebar" : "toolbarRoute";
  const sidebar = navMode === "sidebar" ? "full" : "hidden";
  const topbar = !row.showFooterHints ? "minimal" : row.columns === 2 ? "full" : "condensed";
  return {
    band: row.name,
    sidebar,
    navMode,
    topbar,
    columns: row.columns,
    footerHints: row.showFooterHints,
    tooNarrow: safeWidth < MIN_USABLE_WIDTH
  };
}

// src/tui/tabs.ts
import { visibleWidth as visibleWidth9 } from "@oh-my-pi/pi-tui";
var TAB_ICON = {
  overview: "trendUp",
  activity: "calendar",
  models: "models",
  costs: "cost",
  projects: "projects",
  requests: "requests",
  errors: "errors",
  tools: "tools",
  providers: "providers",
  gain: "gains",
  traces: "time",
  frustration: "warning"
};
var TAB_SHORT = {
  unicode: {
    overview: STATS_ICONS.unicode.trendUp,
    activity: "\u25EB",
    models: STATS_ICONS.unicode.models,
    costs: "$",
    projects: "\u25A3",
    requests: "\u2261",
    errors: STATS_ICONS.unicode.warning,
    tools: "\u2692",
    providers: "\u25C8",
    gain: "+",
    traces: "\u2301",
    frustration: "?"
  },
  nerd: {
    overview: STATS_ICONS.nerd.trendUp,
    activity: STATS_ICONS.nerd.calendar,
    models: STATS_ICONS.nerd.models,
    costs: STATS_ICONS.nerd.cost,
    projects: STATS_ICONS.nerd.projects,
    requests: STATS_ICONS.nerd.requests,
    errors: STATS_ICONS.nerd.errors,
    tools: STATS_ICONS.nerd.tools,
    providers: STATS_ICONS.nerd.providers,
    gain: STATS_ICONS.nerd.gains,
    traces: STATS_ICONS.nerd.time,
    frustration: STATS_ICONS.nerd.warning
  },
  ascii: {
    overview: "*",
    activity: "#",
    models: "M",
    costs: "$",
    projects: "D",
    requests: "R",
    errors: "!",
    tools: "T",
    providers: "H",
    gain: "+",
    traces: "~",
    frustration: "?"
  }
};
function tabBarTheme(theme) {
  return {
    label: (text) => theme.bold(theme.fg(TAB_INK.active, text)),
    activeTab: (text) => theme.bold(theme.bg(SELECTION_BG.band, theme.fg(TAB_INK.active, text))),
    inactiveTab: (text) => theme.fg(TAB_INK.inactive, text),
    mutedTab: (text) => theme.fg(TAB_INK.muted, text),
    hoverTab: (text) => theme.fg(TAB_INK.hover, text),
    hint: (text) => theme.fg(TAB_INK.hint, text)
  };
}
function routeSpans(line, activeId) {
  if (!SCREENS.some((screen) => screen.id === activeId))
    return [];
  if (!line.startsWith("< "))
    return [];
  const index = SCREENS.findIndex((screen) => screen.id === activeId);
  const previous = SCREENS[(index - 1 + SCREENS.length) % SCREENS.length].id;
  const next = SCREENS[(index + 1) % SCREENS.length].id;
  const labelStart = visibleWidth9("< ");
  const labelEnd = labelStart + visibleWidth9(screenById(activeId).label);
  const nextStart = labelEnd + 1;
  const painted = visibleWidth9(line);
  const spans = [];
  if (painted >= 1)
    spans.push({ id: previous, start: 0, end: 1, part: "prev" });
  if (painted > labelStart) {
    spans.push({ id: activeId, start: labelStart, end: Math.min(painted, labelEnd), part: "label" });
  }
  if (painted > nextStart)
    spans.push({ id: next, start: nextStart, end: nextStart + 1, part: "next" });
  return spans;
}
function rawPrefix(line, cells) {
  let index = 0;
  let width = 0;
  while (index < line.length && width < cells) {
    if (line.charCodeAt(index) === 27) {
      const end = line.indexOf("m", index + 1);
      if (end === -1)
        break;
      index = end + 1;
      continue;
    }
    const char = String.fromCodePoint(line.codePointAt(index));
    width += visibleWidth9(char);
    index += char.length;
  }
  return line.slice(0, index);
}
function paintRouteHover(theme, line, activeId) {
  const spans = routeSpans(line.replace(/\x1b\[[0-9;]*m/g, ""), activeId);
  if (spans.length === 0)
    return line;
  const end = Math.max(...spans.map((span) => span.end));
  const prefix = rawPrefix(line, end);
  return theme.bg(SELECTION_BG.band, prefix) + line.slice(prefix.length);
}

// src/tui/chrome.ts
var JUMP_TIMEOUT_MS = 1200;
var TOPBAR_CLUSTER_GAP = "  ";
var TOPBAR_SPACER_MIN = 3;
function pad2(text, width) {
  const short = width - visibleWidth10(text);
  return short > 0 ? `${text}${" ".repeat(short)}` : text;
}
var PREFIX_WIDTH = 2;
var SIDEBAR_GAP = 2;
var JUMP_KEY_PREFIX = "G ";
var INDEXING_VISIBLE_HOURS = 24;
var HOTKEYS = {
  overview: "o",
  models: "m",
  costs: "c",
  activity: "a",
  requests: "r",
  errors: "e",
  tools: "l",
  projects: "j",
  providers: "v",
  gain: "n",
  traces: "t",
  frustration: "f"
};
var GROUPS = {
  Usage: ["overview", "models", "costs", "providers"],
  Activity: ["activity", "requests", "errors", "traces"],
  Insights: ["tools", "projects", "gain", "frustration"]
};
var NAV_GROUPS = Object.entries(GROUPS).map(([heading, ids]) => ({
  heading,
  items: ids.flatMap((id) => {
    const screen = screenById(id);
    const hotkey = HOTKEYS[id] ?? "";
    return hotkey !== "" ? [{ id: screen.id, label: screen.label, hotkey, icon: TAB_ICON[screen.id] }] : [];
  })
}));
function sidebarWidth(preset) {
  const items = NAV_GROUPS.flatMap((group) => group.items);
  const iconWidth = Math.max(...items.map((item) => visibleWidth10(statsIcon(preset, item.icon))));
  const labelWidth = Math.max(...items.map((item) => visibleWidth10(item.label)));
  return PREFIX_WIDTH + iconWidth + 1 + labelWidth + SIDEBAR_GAP + visibleWidth10(JUMP_KEY_PREFIX) + 1;
}
function screenForHotkey(key) {
  if (key.length !== 1)
    return null;
  const lower = key.toLowerCase();
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      if (item.hotkey === lower)
        return item.id;
    }
  }
  return null;
}
function ago(now, lastSyncedAt) {
  if (lastSyncedAt === null)
    return "";
  const s = Math.max(0, Math.round((now - lastSyncedAt) / 1000));
  if (s < 45)
    return "just now";
  const m = Math.round(s / 60);
  if (m < 60)
    return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}
function chipFor(theme, sync) {
  if (sync.error !== null) {
    return `${theme.fg("error", theme.symbol("status.error"))} Sync failed`;
  }
  if (sync.syncing) {
    const mark = theme.fg("accent", theme.symbol("status.running"));
    if (sync.determinate && sync.total > 0) {
      return `${mark} Syncing ${theme.fg("dim", `${formatInteger2(sync.current)}/${formatInteger2(sync.total)}`)}`;
    }
    return `${mark} Syncing`;
  }
  if (sync.live === false)
    return theme.fg("dim", "Cached");
  if (sync.dirtyHours > INDEXING_VISIBLE_HOURS) {
    const mark = theme.fg("accent", theme.symbol("status.running"));
    return `${mark} Indexing ${theme.fg("dim", `${formatInteger2(sync.dirtyHours)}h left`)}`;
  }
  const mark = theme.fg("success", theme.symbol("status.enabled"));
  const age = ago(sync.now, sync.lastSyncedAt);
  return age === "" ? `${mark} Live` : `${mark} Live ${theme.fg("dim", age)}`;
}
var PROGRESS_PHASE = {
  scan: "Scan",
  ingest: "Ingest",
  rollup: "Rollup"
};
function progressLineFor(event, width) {
  if (event === null || event.type !== "progress")
    return "";
  const phase = PROGRESS_PHASE[event.phase];
  const detail = event.phase === "ingest" && event.total > 0 ? ` ${formatInteger2(event.current)}/${formatInteger2(event.total)}` : " \u2026";
  const text = `${phase}${detail}`;
  return visibleWidth10(text) > width ? truncateToWidth12(text, Math.max(0, width)) : text;
}
var SIDEBAR_CACHE = new WeakMap;
var GROUPS_ID = new WeakMap;
var nextGroupsId = 0;
function groupsId(groups) {
  const existing = GROUPS_ID.get(groups);
  if (existing !== undefined)
    return existing;
  const id = `nav${nextGroupsId++}`;
  GROUPS_ID.set(groups, id);
  return id;
}
function sidebar(theme, preset, activeId, hoveredId, groups = NAV_GROUPS) {
  const key = `${groupsId(groups)}${preset}${activeId}${hoveredId ?? ""}`;
  let byKey = SIDEBAR_CACHE.get(theme);
  if (byKey === undefined)
    SIDEBAR_CACHE.set(theme, byKey = new Map);
  const hit = byKey.get(key);
  if (hit !== undefined)
    return { width: hit.width, lines: hit.lines };
  const computed = computeSidebar(theme, preset, activeId, hoveredId ?? null, groups);
  byKey.set(key, computed);
  return { width: computed.width, lines: computed.lines };
}
function computeSidebar(theme, preset, activeId, hoveredId, groups) {
  const activeGroup = groups.find((group) => group.items.some((item) => item.id === activeId));
  const items = groups.flatMap((group) => group.items);
  const iconWidth = Math.max(...items.map((item) => visibleWidth10(statsIcon(preset, item.icon, theme))));
  const measuredLabelWidth = Math.max(...items.map((item) => visibleWidth10(item.label)));
  const keyWidth = visibleWidth10(JUMP_KEY_PREFIX) + 1;
  const measuredWidth = PREFIX_WIDTH + iconWidth + 1 + measuredLabelWidth + SIDEBAR_GAP + keyWidth;
  const width = Math.max(sidebarWidth(preset), measuredWidth);
  const labelWidth = width - (PREFIX_WIDTH + iconWidth + 1 + SIDEBAR_GAP + keyWidth);
  const jump = (key) => theme.fg(SIDEBAR_INK.jumpKey, key);
  const lines = [];
  const tail = " ".repeat(SIDEBAR_GAP);
  for (const group of groups) {
    const heading = group === activeGroup ? theme.bold(theme.fg(SIDEBAR_INK.headingActive, group.heading)) : theme.fg(SIDEBAR_INK.headingInactive, group.heading);
    lines.push(pad2(`  ${heading}`, width));
    for (const item of group.items) {
      const icon = pad2(statsIcon(preset, item.icon, theme), iconWidth);
      const label = pad2(item.label, labelWidth);
      const key = `${JUMP_KEY_PREFIX}${item.hotkey.toUpperCase()}`;
      if (item.id === activeId) {
        lines.push(theme.bg(SELECTION_BG.band, theme.fg(SIDEBAR_INK.rowActive, `${theme.nav.cursor} `) + theme.fg(SIDEBAR_INK.iconActive, theme.bold(icon)) + " " + theme.fg(SIDEBAR_INK.rowActive, theme.bold(label)) + tail + jump(key)));
        continue;
      }
      if (item.id === hoveredId) {
        lines.push(theme.bg(SELECTION_BG.band, `  ${theme.fg(SIDEBAR_INK.iconInactive, icon)} ${theme.fg(SIDEBAR_INK.rowHover, label)}${tail}${jump(key)}`));
        continue;
      }
      lines.push(`  ${theme.fg(SIDEBAR_INK.iconInactive, icon)} ${theme.fg(SIDEBAR_INK.rowInactive, label)}${tail}${jump(key)}`);
    }
  }
  return { width, lines };
}
var SIDEBAR_ZIP_PREFIX = 3;
function zipSidebar(theme, bodyRows, sidebarLines, sidebarWidth, preset) {
  const gutter = theme.fg("dim", glyph(preset, "columnGap"));
  const height = Math.max(bodyRows.length, sidebarLines.length);
  return Array.from({ length: height }, (_, index) => {
    const side = index < sidebarLines.length ? sidebarLines[index] : " ".repeat(sidebarWidth);
    const body = index < bodyRows.length ? bodyRows[index] : "";
    return `${side} ${gutter} ${body}`;
  });
}
var TOPBAR_CACHE = new WeakMap;
var TOPBAR_CACHE_LIMIT = 512;
function topbar(theme, opts) {
  const key = [
    opts.screenLabel,
    opts.range,
    opts.chip,
    opts.freshness,
    opts.progress,
    opts.innerWidth
  ].join("\x00");
  let byKey = TOPBAR_CACHE.get(theme);
  if (byKey === undefined)
    TOPBAR_CACHE.set(theme, byKey = new Map);
  const hit = byKey.get(key);
  if (hit !== undefined)
    return hit;
  const line = computeTopbar(theme, opts);
  if (byKey.size >= TOPBAR_CACHE_LIMIT)
    byKey.clear();
  byKey.set(key, line);
  return line;
}
function computeTopbar(theme, opts) {
  const innerWidth = Math.max(0, opts.innerWidth);
  const policy = framePolicy(innerWidth + HORIZONTAL_INSET);
  const bar = tabBarTheme(theme);
  const screen = opts.screenLabel.trim() || "Stats";
  const label = policy.navMode === "toolbarRoute" ? `${theme.fg("dim", "<")} ${theme.bold(theme.fg("text", screen))} ${theme.fg("dim", ">")}` : theme.bold(theme.fg("text", screen));
  const chip = opts.chip === "" ? "" : theme.bg(SELECTION_BG.band, ` ${opts.chip} `);
  const freshness = opts.freshness === "" ? "" : theme.fg("dim", opts.freshness);
  const progress = opts.progress === "" ? "" : theme.fg("dim", opts.progress);
  const tray = (ids) => ids.map((id) => {
    const cell = ` ${rangeMeta(id).label} `;
    return id === opts.range ? bar.activeTab(cell) : bar.inactiveTab(cell);
  }).join("");
  const fullTray = tray(RANGES);
  const oneTray = tray([opts.range]);
  const layouts = policy.topbar === "full" ? [
    [label, chip, freshness, progress, fullTray],
    [label, chip, freshness, fullTray],
    [label, chip, progress, fullTray],
    [label, chip, fullTray],
    [label, freshness, progress, fullTray],
    [label, progress, fullTray],
    [label, fullTray],
    [label, oneTray]
  ] : policy.topbar === "condensed" ? [
    [label, chip, progress, fullTray],
    [label, chip, fullTray],
    [label, progress, fullTray],
    [label, fullTray],
    [label, oneTray]
  ] : [
    [label, progress, oneTray],
    [label, oneTray]
  ];
  const cluster = (parts) => parts.filter((part) => part !== "").join(TOPBAR_CLUSTER_GAP);
  const labelWidth = visibleWidth10(label);
  for (const layout of layouts) {
    const actions = cluster(layout.slice(1));
    const actionsWidth = visibleWidth10(actions);
    if (labelWidth + TOPBAR_SPACER_MIN + actionsWidth > innerWidth)
      continue;
    const gap = innerWidth - labelWidth - actionsWidth;
    return `${label}${" ".repeat(gap)}${actions}`;
  }
  const last = `${label}${" ".repeat(TOPBAR_SPACER_MIN)}${oneTray}`;
  return visibleWidth10(last) > innerWidth ? truncateToWidth12(last, innerWidth) : last;
}

// src/tui/frame.ts
var MIN_PANEL_ROWS = PANEL_CHROME_ROWS + 1;
function integerOr(value, fallback) {
  return Number.isFinite(value) ? Math.trunc(value) : fallback;
}
function rowsForFrame(rows, headerRows) {
  const totalRows = Math.max(MIN_PANEL_ROWS, integerOr(rows, MIN_PANEL_ROWS));
  const headers = Math.max(0, integerOr(headerRows, 1));
  return Math.max(1, totalRows - (PANEL_CHROME_ROWS - 1) - headers);
}
function budgetFrame(width, rows, headerRows, preset) {
  const safeWidth = Math.max(0, integerOr(width, 0));
  const headers = Math.max(0, integerOr(headerRows, 1));
  const sidebarCols = framePolicy(safeWidth).navMode === "sidebar" ? sidebarWidth(preset) + SIDEBAR_ZIP_PREFIX : 0;
  return {
    topbarRows: headers,
    stripRows: 0,
    bodyRows: rowsForFrame(rows, headers),
    bodyInnerWidth: Math.max(0, safeWidth - HORIZONTAL_INSET - sidebarCols)
  };
}

// src/tui/footer.ts
import { formatKeyHints } from "@oh-my-pi/pi-coding-agent";
import { visibleWidth as visibleWidth11 } from "@oh-my-pi/pi-tui";
function hintsFor(mode, ownsDigits = false) {
  const scroll = { keys: ["up", "down", "home", "end"], label: "scroll" };
  const screen = { keys: ["[", "]", "ctrl+p", "ctrl+n"], label: "screen" };
  const jump = { keys: ["g"], label: "jump" };
  const digits = { keys: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"], label: "screens" };
  const range = { keys: ["r", "shift+r"], label: "range" };
  const refresh = { keys: ["f2"], label: "refresh" };
  const sync = { keys: ["s"], label: "sync" };
  const close = { keys: ["escape", "q"], label: "close" };
  const list = ownsDigits ? [screen, jump, range, refresh, sync, close] : [screen, jump, digits, range, refresh, sync, close];
  switch (mode) {
    case "idle":
      return list;
    case "scrollable":
      return [scroll, ...list];
    case "syncing":
      return ownsDigits ? [screen, jump, range, refresh, close] : [screen, jump, digits, range, refresh, close];
    case "error":
      return [{ keys: ["s"], label: "retry sync" }, close];
  }
}
function footerHints(hints, theme, width = Number.POSITIVE_INFINITY) {
  if (hints.length === 0)
    return [];
  const separator = theme.fg("borderMuted", " \xB7 ");
  const head = hints[0];
  const tail = hints.length > 1 ? hints[hints.length - 1] : undefined;
  const middle = hints.length > 2 ? hints.slice(1, -1) : [];
  const candidates = [];
  for (let kept = middle.length;kept >= 0; kept--) {
    candidates.push(tail === undefined ? [head] : [head, ...middle.slice(0, kept), tail]);
  }
  if (tail !== undefined)
    candidates.push([tail]);
  for (const parts of candidates) {
    const row = theme.fg("dim", parts.map((hint) => `${formatKeyHints(hint.keys)} ${hint.label}`).join(separator));
    if (visibleWidth11(row) <= width)
      return [row];
  }
  return [];
}

// src/tui/mouse.ts
import { visibleWidth as visibleWidth12 } from "@oh-my-pi/pi-tui";
var NO_HIT = { type: "none" };
function sidebarHit(navRow, groups = NAV_GROUPS) {
  if (!Number.isInteger(navRow) || navRow < 0)
    return null;
  let row = 0;
  for (const group of groups) {
    if (navRow === row)
      return null;
    row++;
    for (const item of group.items) {
      if (navRow === row)
        return item.id;
      row++;
    }
  }
  return null;
}
function rangeSpans(line) {
  const spans = [];
  for (const id of RANGES) {
    const cell = ` ${rangeMeta(id).label} `;
    const found = line.lastIndexOf(cell);
    if (found === -1)
      continue;
    const start = visibleWidth12(line.slice(0, found));
    spans.push({ id, start, end: start + visibleWidth12(cell) });
  }
  return spans;
}
function rangeHit(line, col) {
  if (!Number.isInteger(col) || col < 0)
    return null;
  for (const span of rangeSpans(line)) {
    if (col >= span.start && col < span.end)
      return span.id;
  }
  return null;
}
function hitTest(frame, row, col, hitSidebar = sidebarHit) {
  const contentRow = row - 1;
  const contentCol = col - 2;
  if (contentRow < 0 || contentCol < 0)
    return NO_HIT;
  if (contentRow < frame.topbarRows) {
    if (contentRow !== 0)
      return NO_HIT;
    for (const span of frame.routeSpans) {
      if (contentCol >= span.start && contentCol < span.end) {
        return { type: "screen", id: span.id, via: "route" };
      }
    }
    const id = rangeHit(frame.topbar, contentCol);
    return id === null ? NO_HIT : { type: "range", id };
  }
  const bodyRow = contentRow - frame.topbarRows;
  if (bodyRow < 0 || bodyRow >= frame.bodyRows)
    return NO_HIT;
  if (frame.sidebarWidth > 0 && contentCol < frame.sidebarWidth) {
    if (bodyRow >= frame.sidebarRows)
      return NO_HIT;
    const id = hitSidebar(bodyRow);
    return id === null ? NO_HIT : { type: "screen", id, via: "sidebar" };
  }
  const docRow = bodyRow + (frame.bodyScroll ?? 0);
  const bodyCol = contentCol - (frame.sidebarWidth > 0 ? frame.sidebarWidth + 3 : 0);
  for (const hit of frame.bodyHits ?? []) {
    if (docRow >= hit.rowStart && docRow < hit.rowEnd && bodyCol >= hit.colStart && bodyCol < hit.colEnd) {
      return { type: "feature", action: hit.action };
    }
  }
  return NO_HIT;
}

// test/fixtures/panel.ts
var FIXTURE_NOW = Date.UTC(2026, 6, 15, 12, 0, 0);
var DAY2 = 24 * 60 * 60 * 1000;
var HOUR2 = 60 * 60 * 1000;
var dayStart = (daysAgo) => Math.floor((FIXTURE_NOW - daysAgo * DAY2) / DAY2) * DAY2;
var hourStart = (hoursAgo) => Math.floor((FIXTURE_NOW - hoursAgo * HOUR2) / HOUR2) * HOUR2;
var AGGREGATE = {
  totalRequests: 65460,
  successfulRequests: 64145,
  failedRequests: 1315,
  errorRate: 0.0201,
  totalInputTokens: 47100000,
  totalOutputTokens: 9400000,
  totalCacheReadTokens: 1204000000,
  totalCacheWriteTokens: 12800000,
  cacheRate: 0.9624,
  cacheSavings: 0.8142,
  totalCost: 112.36,
  unpricedRequests: 4197,
  totalPremiumRequests: 1.5,
  avgDuration: 12300,
  avgTtft: 430,
  avgTokensPerSecond: 61.2,
  firstTimestamp: FIXTURE_NOW - 30 * DAY2,
  lastTimestamp: FIXTURE_NOW
};
function modelRow(over) {
  return { ...AGGREGATE, ...over };
}
var BY_MODEL = [
  modelRow({
    model: "gpt-5.6-terra",
    provider: "openrouter",
    totalRequests: 1280,
    failedRequests: 4,
    errorRate: 0.0031,
    totalCost: 935.72,
    unpricedRequests: 0,
    totalCacheReadTokens: 512000000,
    avgDuration: 9800,
    cacheRate: 0.961
  }),
  modelRow({
    model: "gemini-3.7-flash-high",
    provider: "google-antigravity",
    totalRequests: 4197,
    failedRequests: 0,
    errorRate: 0,
    totalCost: 0,
    unpricedRequests: 4197,
    totalCacheReadTokens: 571773459,
    avgDuration: 14200,
    cacheRate: 0.955
  }),
  modelRow({
    model: "space-bunny-free",
    provider: "opencode-go",
    totalRequests: 36616,
    failedRequests: 88,
    errorRate: 0.0024,
    totalCost: 0,
    unpricedRequests: 0,
    totalCacheReadTokens: 120226541,
    avgDuration: 18600,
    cacheRate: 0.981
  })
];
var MODEL_SERIES = BY_MODEL.flatMap((m, index) => [0, 1, 2, 3].map((daysAgo) => ({
  timestamp: dayStart(daysAgo),
  model: m.model,
  provider: m.provider,
  requests: Math.max(1, Math.round(m.totalRequests / 40) - index - daysAgo)
})));
var MODEL_PERFORMANCE_SERIES = MODEL_SERIES.map((p) => ({
  ...p,
  avgTtft: 430 + p.model.length % 7 * 10,
  avgTokensPerSecond: 61.2
}));
function costPoint(timestamp, model, cost, tokens, unpricedRequests = 0) {
  return {
    timestamp,
    model,
    provider: "openrouter",
    cost,
    unpricedRequests,
    costInput: cost * 0.1,
    costOutput: cost * 0.05,
    costCacheRead: cost * 0.8,
    costCacheWrite: cost * 0.05,
    requests: Math.max(1, Math.round(tokens / 1000))
  };
}
var COST_SERIES = [
  costPoint(dayStart(20), "space-bunny-free", 0.01, 9000000),
  costPoint(dayStart(0), "gpt-5.6-terra", 42, 1000),
  costPoint(dayStart(0), "space-bunny-free", 0.02, 4000000),
  costPoint(dayStart(0), "gemini-3.7-flash-high", 0, 571773459, 4197)
];
var TIME_SERIES = [
  ...Array.from({ length: 29 }, (_, index) => {
    const requests = 90 + index * 37 % 240;
    return {
      timestamp: dayStart(29 - index) + 12 * HOUR2,
      requests,
      errors: 1 + index * 7 % 9,
      tokens: requests * 4000,
      cost: Math.round(requests * 0.03 * 100) / 100
    };
  }),
  ...Array.from({ length: 24 }, (_, index) => {
    const requests = 420 - index * 12;
    return {
      timestamp: hourStart(23 - index),
      requests,
      errors: [4, 2, 9, 1][index % 4],
      tokens: requests * 90000,
      cost: Math.round(requests * 0.09 * 100) / 100
    };
  })
];
var FOLDERS = [
  {
    ...AGGREGATE,
    folder: "/Users/yuzu/Documents/Projects/omp-stats-tui",
    totalRequests: 31002,
    totalCost: 74.1,
    unpricedRequests: 0,
    lastTimestamp: FIXTURE_NOW - HOUR2
  },
  {
    ...AGGREGATE,
    folder: "/Users/yuzu/Documents/Projects/other",
    totalRequests: 18458,
    totalCost: 31.26,
    unpricedRequests: 0,
    lastTimestamp: FIXTURE_NOW - 9 * HOUR2
  },
  {
    ...AGGREGATE,
    folder: "scratch",
    totalRequests: 16000,
    totalCost: 7,
    unpricedRequests: 4197,
    lastTimestamp: FIXTURE_NOW - 30 * HOUR2
  }
];
function messageRow(over = {}) {
  const { usage, ...rest } = over;
  const cost = usage?.cost ?? {};
  return {
    id: 1,
    sessionFile: "/Users/yuzu/.omp/sessions/a.jsonl",
    entryId: "e1",
    folder: "/Users/yuzu/Documents/Projects/omp-stats-tui",
    model: "gpt-5.6-terra",
    provider: "openrouter",
    api: "openai-completions",
    timestamp: FIXTURE_NOW - 4 * 60000,
    duration: 12300,
    ttft: 430,
    stopReason: "stop",
    errorMessage: null,
    agentType: "main",
    costUnpriced: false,
    ...rest,
    usage: {
      input: 47100,
      output: 9400,
      cacheRead: 1204000,
      cacheWrite: 12800,
      totalTokens: 1273300,
      premiumRequests: 0,
      ...usage,
      cost: {
        input: 0.04,
        output: 0.02,
        cacheRead: 0.34,
        cacheWrite: 0.02,
        total: cost.total ?? 0.42,
        ...cost
      }
    }
  };
}
var RECENT = [
  messageRow({ id: 1 }),
  messageRow({
    id: 2,
    timestamp: FIXTURE_NOW - 40 * 60000,
    model: "space-bunny-free",
    provider: "opencode-go",
    folder: "scratch",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 1000,
      cacheWrite: 0,
      totalTokens: 1000,
      cost: { total: 0 }
    },
    costUnpriced: true
  }),
  messageRow({
    id: 3,
    timestamp: FIXTURE_NOW - 3 * HOUR2,
    provider: "google-antigravity",
    stopReason: "error",
    errorMessage: "429 Too Many Requests",
    costUnpriced: true,
    usage: { cost: { total: 0 } }
  })
];
var ERRORS = RECENT.filter((r) => r.errorMessage !== null);
var TOOLS = {
  byTool: [
    {
      tool: "read",
      calls: 4021,
      errors: 3,
      argsChars: 88120,
      resultChars: 412880,
      totalTokensShare: 90100000,
      outputTokensShare: 12400000,
      costShare: 18.4,
      unpricedRequestsShare: 0,
      lastUsed: FIXTURE_NOW - 5 * 60000
    },
    {
      tool: "bash",
      calls: 1884,
      errors: 41,
      argsChars: 21400,
      resultChars: 96220,
      totalTokensShare: 30400000,
      outputTokensShare: 4100000,
      costShare: 6.9,
      unpricedRequestsShare: 0,
      lastUsed: FIXTURE_NOW - 2 * 60000
    },
    {
      tool: "grep",
      calls: 610,
      errors: 0,
      argsChars: 9100,
      resultChars: 51800,
      totalTokensShare: 8900000,
      outputTokensShare: 1200000,
      costShare: 1.1,
      unpricedRequestsShare: 0,
      lastUsed: FIXTURE_NOW - HOUR2
    }
  ],
  byToolModel: [
    {
      tool: "read",
      model: "gpt-5.6-terra",
      provider: "openrouter",
      calls: 2400,
      errors: 1,
      argsChars: 50000,
      resultChars: 240000,
      totalTokensShare: 55000000,
      outputTokensShare: 7500000,
      costShare: 12.2,
      unpricedRequestsShare: 0,
      lastUsed: FIXTURE_NOW - 5 * 60000
    },
    {
      tool: "read",
      model: "space-bunny-free",
      provider: "opencode-go",
      calls: 1621,
      errors: 2,
      argsChars: 38120,
      resultChars: 172880,
      totalTokensShare: 35100000,
      outputTokensShare: 4900000,
      costShare: 6.2,
      unpricedRequestsShare: 0,
      lastUsed: FIXTURE_NOW - 5 * 60000
    }
  ],
  series: [
    { timestamp: hourStart(23), tool: "read", calls: 120, errors: 0 },
    { timestamp: hourStart(12), tool: "read", calls: 96, errors: 1 },
    { timestamp: hourStart(23), tool: "bash", calls: 41, errors: 2 },
    { timestamp: hourStart(12), tool: "bash", calls: 33, errors: 1 },
    { timestamp: hourStart(23), tool: "grep", calls: 12, errors: 0 },
    { timestamp: hourStart(12), tool: "grep", calls: 9, errors: 0 }
  ]
};
var PROVIDERS = {
  providers: [
    {
      provider: "openrouter",
      totalRequests: 1280,
      failedRequests: 4,
      models: 1,
      totalInputTokens: 2100000,
      totalOutputTokens: 400000,
      totalCacheReadTokens: 51000000,
      totalCacheWriteTokens: 500000,
      totalTokens: 54000000,
      totalCost: 935.72,
      unpricedRequests: 0,
      totalPremiumRequests: 0,
      avgTokensPerSecond: 61.2
    },
    {
      provider: "google-antigravity",
      totalRequests: 4197,
      failedRequests: 0,
      models: 1,
      totalInputTokens: 8000000,
      totalOutputTokens: 1500000,
      totalCacheReadTokens: 190000000,
      totalCacheWriteTokens: 2000000,
      totalTokens: 201500000,
      totalCost: 0,
      unpricedRequests: 4197,
      totalPremiumRequests: 0,
      avgTokensPerSecond: null
    },
    {
      provider: "opencode-go",
      totalRequests: 36616,
      failedRequests: 88,
      models: 1,
      totalInputTokens: 37000000,
      totalOutputTokens: 7500000,
      totalCacheReadTokens: 963000000,
      totalCacheWriteTokens: 10300000,
      totalTokens: 1017800000,
      totalCost: 0,
      unpricedRequests: 0,
      totalPremiumRequests: 1.5,
      avgTokensPerSecond: 58.4
    }
  ],
  hourly: [
    { provider: "openrouter", hour: 9, totalTokens: 9400000, outputTokens: 800000, requests: 210 },
    { provider: "opencode-go", hour: 14, totalTokens: 88000000, outputTokens: 7000000, requests: 3100 }
  ],
  series: [
    { timestamp: dayStart(1), provider: "openrouter", totalTokens: 20000000, cost: 310.4, unpricedRequests: 0, requests: 420 },
    { timestamp: dayStart(0), provider: "opencode-go", totalTokens: 300000000, cost: 0, unpricedRequests: 0, requests: 9100 }
  ],
  insights: [
    { provider: "openrouter", windowKey: "day", windowLabel: "Daily", accounts: 2, cycles: 12, fractionConsumed: 0.42, estTokensPerWindow: 48000000, peakConcurrentFraction: 1.1, idealAccounts: 2, exhaustedEvents: 0 },
    { provider: "opencode-go", windowKey: "week", windowLabel: "Weekly", accounts: 1, cycles: 3, fractionConsumed: 0.08, estTokensPerWindow: 900000000, peakConcurrentFraction: 0.31, idealAccounts: 1, exhaustedEvents: 0 }
  ]
};
var DAILY_ACTIVITY = Array.from({ length: 40 }, (_, i) => {
  const daysAgo = 39 - i;
  const busy = daysAgo === 12;
  const requests = busy ? 2004 : i % 7 + 1;
  return {
    day: new Date(FIXTURE_NOW - daysAgo * DAY2).toISOString().slice(0, 10),
    cost: busy ? 611.4 : Math.round(i % 7 * 3.11 * 100) / 100,
    requests,
    totalTokens: i % 7 * 1200000,
    unpricedRequests: i % 7 === 0 ? requests : 0
  };
});

// src/tui/panel.ts
var STATS_OVERLAY_OPTIONS = {
  anchor: "top-left",
  width: "100%",
  maxHeight: "100%",
  margin: 0,
  fullscreen: true
};
var EXACT_DIRTY_LIMIT = 96;
var NO_ROWS = [];
var SELECTABLE_SCREENS = SCREENS;
var DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"];
var RANGE_KEYS = ["1", "2", "3", "4", "5", "6"];
function panelAction(data, jumpArmed = false) {
  let wheel = null;
  if (routeSgrMouseInput(data, (event) => {
    if (event.wheel === null)
      return false;
    wheel = event.wheel;
    return true;
  })) {
    return wheel === null || wheel === 0 ? null : { type: "scroll", rows: wheel * 2 };
  }
  if (jumpArmed && data.length === 1) {
    const rangeIndex = RANGE_KEYS.indexOf(data);
    if (rangeIndex !== -1)
      return { type: "rangeId", id: RANGES[rangeIndex] };
    const id = screenForHotkey(data);
    return id === null ? { type: "noop" } : { type: "screenId", id };
  }
  if (getKeybindings().matches(data, "tui.select.cancel") || matchesKey2(data, "q"))
    return { type: "close" };
  if (data === "g" || data === "G")
    return { type: "armJump" };
  if (getKeybindings().matches(data, "tui.select.up"))
    return { type: "scroll", rows: -1 };
  if (getKeybindings().matches(data, "tui.select.down"))
    return { type: "scroll", rows: 1 };
  if (getKeybindings().matches(data, "tui.select.pageUp"))
    return { type: "scroll", viewport: -1 };
  if (getKeybindings().matches(data, "tui.select.pageDown"))
    return { type: "scroll", viewport: 1 };
  if (data === "[" || matchesKey2(data, "ctrl+p"))
    return { type: "screen", by: -1 };
  if (data === "]" || matchesKey2(data, "ctrl+n"))
    return { type: "screen", by: 1 };
  if (matchesKey2(data, "left") || matchesKey2(data, "shift+tab"))
    return { type: "screen", by: -1 };
  if (matchesKey2(data, "right") || matchesKey2(data, "tab"))
    return { type: "screen", by: 1 };
  if (matchesKey2(data, "shift+r"))
    return { type: "range", by: -1 };
  if (matchesKey2(data, "r"))
    return { type: "range", by: 1 };
  if (matchesKey2(data, "s"))
    return { type: "sync" };
  if (matchesKey2(data, "f2"))
    return { type: "refresh" };
  const digit = DIGITS.indexOf(data);
  if (digit !== -1)
    return { type: "screenIndex", index: digit };
  if (matchesKey2(data, "home"))
    return { type: "scrollTo", edge: "top" };
  if (matchesKey2(data, "end"))
    return { type: "scrollTo", edge: "bottom" };
  return null;
}
var STATE = new WeakMap;

class StatsPanel {
  #options;
  #tui;
  #theme;
  #panel;
  #header;
  #body;
  #footer;
  #state;
  #reads;
  #features = new Map;
  #featureContext;
  #traceOrigin;
  #liveStatus;
  #refreshTimer;
  #frameCache;
  #featureRevision = 0;
  constructor(options) {
    this.#options = options;
    this.#tui = options.tui;
    this.#theme = options.theme;
    this.#reads = options.reads ?? new StatsReadClient;
    this.#state = {
      range: options.range ?? DEFAULT_RANGE,
      screenId: options.screenId ?? (SELECTABLE_SCREENS[0]?.id ?? "overview"),
      jumpArmedAt: 0,
      scroll: 0,
      maxScroll: 0,
      viewportRows: 0,
      data: null,
      error: null,
      identity: "",
      generation: 0,
      composes: 0,
      readStage: "initializing",
      closed: false,
      done: false,
      syncEvent: null,
      lastSyncedAt: null,
      syncError: null,
      readError: null,
      doneCalls: 0,
      hoveredSidebarId: null,
      hoveredStripId: null,
      mouse: null,
      bodyHits: [],
      featureHits: [],
      source: NO_ROWS,
      title: "Stats"
    };
    STATE.set(this, this.#state);
    this.#panel = new OverlayPanel("Stats", "omp.overlay.stats");
    this.#header = new PanelRows;
    this.#header.setHeight(1);
    this.#body = new PanelRows;
    this.#footer = new PanelRows;
    this.#footer.setHeight(1);
    this.#panel.addChild(this.#header);
    this.#panel.addChild(this.#body);
    this.#panel.addChild(new PanelDivider);
    this.#panel.addChild(this.#footer);
    this.#reads.subscribe((status) => {
      if (this.#state.closed)
        return;
      const previous = this.#liveStatus;
      this.#liveStatus = status;
      this.#state.lastSyncedAt = status.sync.lastSyncedAt;
      this.#state.syncError = status.sync.error;
      this.#state.syncEvent = status.sync.phase === "syncing" ? { type: "progress", phase: "ingest", current: status.sync.current, total: status.sync.total } : null;
      if (previous && (previous.version !== status.version || previous.sync.lastSyncedAt !== status.sync.lastSyncedAt))
        this.#load();
      this.#changed();
    }, (error) => {
      if (this.#state.closed)
        return;
      this.#state.syncEvent = null;
      this.#state.syncError = error.message;
      this.#changed();
    });
    this.#load();
  }
  #needs() {
    return ["rollupStatus"];
  }
  #feature() {
    const id = this.#state.screenId;
    let feature = this.#features.get(id);
    if (feature)
      return feature;
    const ctx = this.#featureContext ??= {
      reader: {
        api: (path, params, options) => this.#reads.api(path, params, options),
        fetch: async (needs, range) => {
          const fetched = await this.#reads.fetch(needs, range);
          return "data" in fetched ? fetched : { data: fetched, errors: {} };
        }
      },
      theme: this.#theme,
      changed: () => {
        this.#featureRevision++;
        this.#changed();
      },
      copy: async (text) => {
        copyToClipboard(text);
      },
      now: () => this.#options.now?.() ?? Date.now(),
      reportHits: (hits) => {
        this.#state.featureHits.push(...hits);
      },
      openScreen: (target) => this.#selectScreen(this.#indexOf(target)),
      backToOrigin: () => {
        const origin = this.#traceOrigin;
        if (!origin)
          return false;
        this.#traceOrigin = undefined;
        this.#selectScreen(this.#indexOf(origin));
        return true;
      },
      openTrace: (file, entryId) => {
        if (this.#state.screenId !== "traces")
          this.#traceOrigin = this.#state.screenId;
        this.#selectScreen(this.#indexOf("traces"));
        this.#feature()?.openTrace?.(file, entryId);
      }
    };
    feature = createCoreFeature(id, ctx) ?? (id === "providers" ? createProvidersFeature(ctx) : id === "gain" ? createGainFeature(ctx) : id === "traces" ? createTracesFeature(ctx) : id === "frustration" ? createFrustrationFeature(ctx) : undefined);
    if (feature)
      this.#features.set(id, feature);
    return feature;
  }
  #load() {
    const state = this.#state;
    if (state.closed)
      return;
    clearTimeout(this.#refreshTimer);
    this.#refreshTimer = undefined;
    const identity = `${state.screenId}:${state.range}`;
    if (identity !== state.identity) {
      state.identity = identity;
      state.data = null;
      state.error = null;
      state.scroll = 0;
    }
    state.generation++;
    const generation = state.generation;
    LOADS.set(this, (async () => {
      try {
        const range = state.range;
        const feature = this.#feature();
        await feature?.load(range);
        if (this.#superseded(generation))
          return;
        const needs = this.#needs();
        const fetched = await this.#reads.fetch(needs, range, (stage) => {
          if (this.#superseded(generation))
            return;
          state.readStage = stage;
          this.#changed();
        });
        if (this.#superseded(generation))
          return;
        const settlement = "data" in fetched ? fetched : { data: fetched, errors: {}, freshness: fetched.freshness };
        state.data = {
          ...settlement.data,
          ...settlement.freshness ? { freshness: settlement.freshness } : {}
        };
        const failures = Object.entries(settlement.errors ?? {}).filter(([, message]) => typeof message === "string" && message.length > 0).map(([need, message]) => `${need}: ${message}`);
        const settledData = Object.keys(settlement.data ?? {}).length > 0;
        state.readError = settledData && failures.length > 0 ? failures.join("; ") : null;
        state.error = !settledData && failures.length > 0 ? failures.join("; ") : null;
      } catch (error) {
        if (this.#superseded(generation))
          return;
        const diagnostic = error instanceof Error ? error.message : String(error);
        if (state.data)
          state.syncError = diagnostic;
        else
          state.error = diagnostic;
      } finally {
        if (!this.#superseded(generation)) {
          this.#changed();
          this.#refreshTimer = setTimeout(() => {
            this.#refreshTimer = undefined;
            this.#load();
          }, state.screenId === "traces" ? 5000 : 30000);
        }
      }
    })());
  }
  #superseded(generation) {
    return this.#state.closed || generation !== this.#state.generation;
  }
  #changed() {
    (this.#options.requestRender ?? (() => this.#tui.requestRender()))();
  }
  #beginSync() {
    const state = this.#state;
    if (state.closed)
      return;
    this.#reads.requestSync().catch((error) => {
      if (state.closed)
        return;
      state.syncError = error instanceof Error ? error.message : String(error);
      this.#changed();
    });
  }
  #chromeSync() {
    const state = this.#state;
    const sync = this.#liveStatus?.sync;
    return {
      syncing: sync?.phase === "syncing",
      current: sync?.current ?? 0,
      total: sync?.total ?? 0,
      determinate: sync?.phase === "syncing" && sync.total > 0,
      error: state.syncError,
      dirtyHours: state.data?.rollupStatus?.dirtyHours ?? 0,
      live: this.#liveStatus !== undefined,
      lastSyncedAt: state.lastSyncedAt,
      now: this.#options.now?.() ?? Date.now()
    };
  }
  #frameKey(width, rows, preset) {
    const state = this.#state;
    const event = state.syncEvent;
    return [
      width,
      rows,
      state.screenId,
      state.range,
      preset,
      state.generation,
      state.error ?? "",
      state.syncError ?? "",
      state.readError ?? "",
      state.readStage,
      event === null ? "" : `${event.type} ${event.phase} ${event.current} ${event.total}`,
      state.lastSyncedAt ?? -1,
      state.hoveredSidebarId,
      state.hoveredStripId,
      this.#featureRevision
    ].join(" ");
  }
  #freshness() {
    const dirty = this.#state.data?.rollupStatus?.dirtyHours ?? 0;
    return dirty > 0 ? this.#theme.fg(dirty > EXACT_DIRTY_LIMIT ? "warning" : "dim", `${dirty} dirty ${dirty === 1 ? "hour" : "hours"}`) : "";
  }
  #toolbar(innerWidth) {
    const state = this.#state;
    const chip = this.#phase() === "error" ? this.#theme.fg("error", `${this.#theme.symbol("status.error")} Read failed`) : chipFor(this.#theme, this.#chromeSync());
    const progress = progressLineFor(state.syncEvent, innerWidth);
    const top = topbar(this.#theme, {
      screenLabel: screenById(state.screenId).label,
      range: state.range,
      chip,
      freshness: this.#freshness(),
      progress,
      innerWidth
    });
    return state.hoveredStripId === null ? top : paintRouteHover(this.#theme, top, state.screenId);
  }
  #refreshChrome(frame, width) {
    frame.topbar = this.#toolbar(Math.max(1, width - HORIZONTAL_INSET));
  }
  #frame(width, rows, preset) {
    const state = this.#state;
    const key = this.#frameKey(width, rows, preset);
    const cached = this.#frameCache;
    if (cached !== undefined && cached.key === key && cached.theme === this.#theme && cached.data === state.data && cached.liveStatus === this.#liveStatus) {
      state.source = cached.source;
      state.bodyHits = cached.bodyHits;
      state.featureHits = cached.featureHits;
      this.#refreshChrome(cached, width);
      return cached;
    }
    const budget = budgetFrame(width, rows, 1, preset);
    const top = this.#toolbar(Math.max(1, width - HORIZONTAL_INSET));
    const policy = framePolicy(width);
    const nav = policy.navMode === "sidebar" ? sidebar(this.#theme, preset, state.screenId, state.hoveredSidebarId) : null;
    const sidebarWidth = nav?.width ?? 0;
    const plan = planLayout(budget.bodyInnerWidth + HORIZONTAL_INSET, rows, preset, budget.bodyRows);
    const source = this.#bodyLines(plan, preset);
    state.source = source;
    const frame = {
      key,
      theme: this.#theme,
      data: state.data,
      liveStatus: this.#liveStatus,
      budget,
      topbar: top,
      nav,
      sidebarWidth,
      plan,
      source,
      bodyHits: state.bodyHits,
      featureHits: state.featureHits
    };
    this.#frameCache = frame;
    state.composes++;
    return frame;
  }
  render(width) {
    const state = this.#state;
    const rows = this.#options.rows ?? this.#tui.terminal.rows ?? 40;
    if (activeTheme && this.#theme !== activeTheme) {
      this.#theme = activeTheme;
      if (this.#featureContext)
        this.#featureContext.theme = activeTheme;
    }
    const preset = this.#theme.getSymbolPreset();
    const frame = this.#frame(width, rows, preset);
    const { plan, nav, budget } = frame;
    state.maxScroll = Math.max(0, state.source.length - plan.bodyRows);
    state.viewportRows = plan.bodyRows;
    state.scroll = Math.max(0, Math.min(state.scroll, state.maxScroll));
    const topbarLine = stripAnsi(frame.topbar);
    state.mouse = {
      topbarRows: budget.topbarRows,
      stripRows: budget.stripRows,
      sidebarWidth: frame.sidebarWidth,
      sidebarRows: nav === null ? 0 : Math.min(nav.lines.length, budget.bodyRows),
      bodyRows: budget.bodyRows,
      topbar: topbarLine,
      routeSpans: routeSpans(topbarLine, state.screenId),
      bodyScroll: state.scroll,
      bodyHits: state.bodyHits
    };
    state.title = "Stats";
    this.#panel.title = state.title;
    this.#header.setLines([frame.topbar]);
    this.#header.setHeight(budget.topbarRows);
    const visible = state.source.slice(state.scroll, state.scroll + plan.bodyRows);
    const navLines = nav === null ? NO_ROWS : nav.lines.slice(0, budget.bodyRows);
    this.#body.setLines(nav === null ? visible : zipSidebar(this.#theme, visible, navLines, frame.sidebarWidth, preset));
    this.#body.setHeight(budget.bodyRows);
    this.#footer.setLines([this.#footerLine(plan, Math.max(1, width - HORIZONTAL_INSET))]);
    return this.#panel.render(width);
  }
  #phase() {
    const state = this.#state;
    if (state.error !== null)
      return "error";
    return state.data !== null ? "ready" : "loading";
  }
  #bodyLines(plan, preset) {
    const state = this.#state;
    const phase = this.#phase();
    state.bodyHits = [];
    state.featureHits = [];
    if (phase === "loading")
      return loadingLines(this.#theme, state.readStage);
    if (phase === "error")
      return errorLines(this.#theme, preset, state.error ?? "", state.syncError).flatMap((line) => wrapTextWithAnsi9(line, plan.innerWidth));
    const data = state.data;
    const notices = [];
    if (state.syncError)
      notices.push(this.#theme.fg("warning", `Stats service failed; retained cached data. ${stripTerminalSequences2(state.syncError)}`));
    if (state.readError)
      notices.push(this.#theme.fg("warning", `Read failed; retained cached data. ${stripTerminalSequences2(state.readError)}`));
    if (data.freshness?.pendingSessions) {
      notices.push(this.#theme.fg("warning", `${data.freshness.pendingSessions} transcript files have un-ingested changes. Press s to sync.`));
    }
    if (data.freshness?.records === 0) {
      notices.push(this.#theme.fg("dim", data.freshness.pendingSessions ? "No ingested requests yet; this is not measured zero usage." : "No recorded requests found."));
    }
    if (data.recent && state.screenId === "requests") {
      notices.push(this.#theme.fg("dim", `Loaded ${data.recent.length} requests in the selected range${data.recent.length === 50 ? "; latest 50 may not cover the complete range." : "."}`));
    }
    const feature = this.#feature();
    if (feature) {
      const noticeLines = notices.flatMap((line) => wrapTextWithAnsi9(line, plan.innerWidth));
      const rendered = feature.render(plan.innerWidth, Math.max(1, plan.bodyRows - noticeLines.length));
      if (feature.handleHit) {
        const offset = noticeLines.length;
        state.bodyHits = state.featureHits.map((hit) => ({
          ...hit,
          rowStart: hit.rowStart + offset,
          rowEnd: hit.rowEnd + offset
        }));
      }
      return [...noticeLines, ...rendered];
    }
    return [this.#theme.fg("muted", `No feature for "${state.screenId}".`)];
  }
  #footerLine(plan, width) {
    const state = this.#state;
    const mode = state.error !== null ? "error" : this.#liveStatus?.sync.phase === "syncing" ? "syncing" : state.maxScroll > 0 ? "scrollable" : "idle";
    const hints = this.#feature()?.inputMode === "text" ? [
      { keys: ["escape"], label: "finish / close" },
      { keys: ["ctrl+p", "ctrl+n"], label: "screen" }
    ] : hintsFor(mode, this.#indexOf(state.screenId) >= DIGITS.length);
    const scrollPosition = state.maxScroll > 0 ? `${state.scroll + 1}\u2013${Math.min(state.source.length, state.scroll + plan.bodyRows)}/${state.source.length}` : "";
    const position = visibleWidth13(scrollPosition) + 12 <= width ? scrollPosition : "";
    const reserve = position ? visibleWidth13(position) + 2 : 0;
    const hintWidth = Math.max(0, width - reserve);
    const [row = ""] = footerHints(hints, this.#theme, hintWidth);
    return position ? row + " ".repeat(Math.max(2, width - visibleWidth13(row) - visibleWidth13(position))) + this.#theme.fg("dim", position) : row;
  }
  handleInput(data) {
    const state = this.#state;
    if (state.closed)
      return;
    if (routeSgrMouseInput(data, (event) => this.#routeMouse(event)))
      return;
    const armed = state.jumpArmedAt !== 0 && (this.#options.now?.() ?? Date.now()) - state.jumpArmedAt < JUMP_TIMEOUT_MS;
    state.jumpArmedAt = 0;
    const feature = this.#feature();
    const editing = feature?.inputMode === "text";
    let action = null;
    if (matchesKey2(data, "ctrl+p") || matchesKey2(data, "ctrl+n")) {
      action = panelAction(data, armed);
      if (action?.type === "screen") {
        this.#selectScreen(this.#indexOf(state.screenId) + action.by);
        return;
      }
    }
    if (!editing && (data === "[" || data === "]")) {
      this.#selectScreen(this.#indexOf(state.screenId) + (data === "[" ? -1 : 1));
      return;
    }
    if (!armed && feature?.handleInput(data)) {
      if (editing || this.#feature()?.inputMode === "text" || matchesKey2(data, "tab") || matchesKey2(data, "shift+tab") || matchesKey2(data, "enter") || matchesKey2(data, "escape"))
        state.scroll = 0;
      return;
    }
    action ??= panelAction(data, armed);
    if (action === null)
      return;
    switch (action.type) {
      case "close":
        this.#finish();
        return;
      case "scroll":
        this.#scrollBy(action.viewport ? action.viewport * Math.max(1, state.viewportRows) : action.rows ?? 0);
        return;
      case "scrollTo":
        state.scroll = action.edge === "top" ? 0 : state.maxScroll;
        this.#changed();
        return;
      case "screen":
        this.#selectScreen(this.#indexOf(state.screenId) + action.by);
        return;
      case "screenIndex":
        this.#selectScreen(action.index);
        return;
      case "screenId": {
        const index = SELECTABLE_SCREENS.findIndex((screen) => screen.id === action.id);
        if (index !== -1)
          this.#selectScreen(index);
        return;
      }
      case "armJump":
        state.jumpArmedAt = this.#options.now?.() ?? Date.now();
        return;
      case "noop":
        return;
      case "range":
        state.range = nextRange(state.range, action.by);
        this.#load();
        return;
      case "rangeId":
        if (action.id !== state.range) {
          state.range = action.id;
          this.#load();
        }
        return;
      case "refresh":
        this.#load();
        return;
      case "sync":
        this.#beginSync();
        return;
    }
  }
  #routeMouse(event) {
    const state = this.#state;
    if (event.wheel !== null) {
      this.#scrollBy(event.wheel * 2);
      return true;
    }
    const frame = state.mouse;
    if (frame === null)
      return true;
    if (event.motion) {
      const hit = hitTest(frame, event.row, event.col);
      if (hit.type === "screen" && hit.via === "route") {
        state.hoveredStripId = hit.id;
        state.hoveredSidebarId = null;
      } else {
        state.hoveredStripId = null;
        state.hoveredSidebarId = hit.type === "screen" && hit.via === "sidebar" ? hit.id : null;
      }
      this.#changed();
      return true;
    }
    if (!event.leftClick)
      return true;
    const hit = hitTest(frame, event.row, event.col);
    if (hit.type === "screen") {
      const index = SELECTABLE_SCREENS.findIndex((screen) => screen.id === hit.id);
      if (index !== -1)
        this.#selectScreen(index);
    } else if (hit.type === "range" && hit.id !== state.range) {
      state.range = hit.id;
      this.#load();
    } else if (hit.type === "feature") {
      this.#feature()?.handleHit?.(hit.action);
    }
    return true;
  }
  #indexOf(id) {
    return SELECTABLE_SCREENS.findIndex((screen) => screen.id === id);
  }
  #selectScreen(index) {
    const state = this.#state;
    const count = SELECTABLE_SCREENS.length;
    if (count === 0)
      return;
    const screen = SELECTABLE_SCREENS[(index % count + count) % count];
    if (screen.id === state.screenId)
      return;
    if (state.screenId === "traces" && screen.id !== "traces")
      this.#traceOrigin = undefined;
    state.hoveredStripId = null;
    state.hoveredSidebarId = null;
    state.screenId = screen.id;
    state.scroll = 0;
    this.#load();
  }
  #scrollBy(delta) {
    this.#state.scroll = Math.max(0, Math.min(this.#state.scroll + delta, this.#state.maxScroll));
    this.#changed();
  }
  #finish() {
    const state = this.#state;
    if (state.done)
      return;
    state.done = true;
    this.dispose();
    state.doneCalls++;
    this.#options.done();
  }
  dispose() {
    const state = this.#state;
    if (state.closed)
      return;
    state.closed = true;
    clearTimeout(this.#refreshTimer);
    this.#refreshTimer = undefined;
    for (const feature of this.#features.values())
      feature.dispose();
    this.#features.clear();
    this.#reads.close();
    this.#panel.dispose();
  }
}
function loadingLines(theme, stage) {
  return [
    theme.fg("dim", stage === "initializing" ? "Initializing stats database\u2026" : "Reading usage\u2026"),
    "",
    theme.fg("dim", "Stats work runs in a separate process. Navigation and close remain available.")
  ];
}
function errorLines(theme, preset, error, syncError) {
  const lines = [
    `${statsIcon(preset, "warning", theme)} ${theme.fg("warning", theme.bold("Usage could not be read"))}`,
    "",
    error,
    "",
    theme.fg("dim", "No observations loaded. Usage and cost are unavailable, not zero.")
  ];
  if (syncError)
    lines.push("", `Background sync: ${syncError}`);
  return lines;
}
var LOADS = new WeakMap;
var ANSI = /\x1b\[[0-9;]*m/g;
var stripAnsi = (text) => text.replace(ANSI, "");

// src/index.ts
var PINNED = "18.18.2";
function src_default(pi) {
  if (VERSION !== PINNED) {
    console.error(`[stats-tui] built against omp ${PINNED}, host is ${VERSION}`);
  }
  pi.registerCommand("stats-tui", {
    description: "Local usage stats, fullscreen",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/stats-tui needs an interactive terminal", "warning");
        return;
      }
      await ctx.ui.custom((tui, theme, _keybindings, done) => new StatsPanel({
        tui,
        theme,
        done: () => done(undefined),
        requestRender: () => tui.requestRender()
      }), { overlay: true, overlayOptions: STATS_OVERLAY_OPTIONS });
    }
  });
}
export {
  src_default as default
};
