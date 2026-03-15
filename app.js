import express from "express";
import ping from "ping";
import path from "path";
import fs from "fs";

const app = express();
const PORT = 5555;
const PING_INTERVAL = 5000; // 5 seconds
const NTFY_TOPIC = "emil-internet-925";

const __dirname = path.resolve();
const DATA_FILE = path.join(__dirname, "data", "state.json");

// ---------------------------------------------------------------------------
// In-memory state — loaded from disk on startup
// ---------------------------------------------------------------------------

let uptimeHistory = [];
let aggregates = [];
let appStartTime = Date.now();
let totalMonitoredMs = 0; // cumulative monitored ms across restarts

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

function loadState() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const state = JSON.parse(raw);
    if (Array.isArray(state.aggregates)) aggregates = state.aggregates;
    if (Array.isArray(state.uptimeHistory)) uptimeHistory = state.uptimeHistory;
    if (typeof state.appStartTime === "number") appStartTime = state.appStartTime;
    if (typeof state.totalMonitoredMs === "number") totalMonitoredMs = state.totalMonitoredMs;
    console.log(`State loaded: ${aggregates.length} aggregate chunks, ${uptimeHistory.length} history entries, started ${new Date(appStartTime).toISOString()}`);
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error("Failed to load state from disk:", err);
    } else {
      console.log("No existing state file found — starting fresh.");
    }
  }
}

function saveState() {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify({ appStartTime, aggregates, uptimeHistory, totalMonitoredMs }));
  } catch (err) {
    console.error("Failed to save state to disk:", err);
  }
}

function clearState() {
  uptimeHistory.length = 0;
  aggregates.length = 0;
  appStartTime = Date.now();
  totalMonitoredMs = 0;
  try {
    fs.rmSync(DATA_FILE, { force: true });
  } catch (err) {
    console.error("Failed to delete state file:", err);
  }
}

// Load persisted state before anything else
loadState();

// Save history every 60 seconds so we lose at most ~1 min of pings on an unclean exit.
// Also checkpoint totalMonitoredMs so unclean shutdowns don't lose session duration.
setInterval(() => {
  totalMonitoredMs += Date.now() - appStartTime;
  appStartTime = Date.now(); // reset session start to now
  saveState();
}, 60000);

// Save on clean shutdown — accumulate monitored time so "monitoring for" survives restarts
function shutdown() {
  totalMonitoredMs += Date.now() - appStartTime;
  saveState();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  if (seconds / 86400 >= 1) return Math.floor(seconds / 86400) + " days";
  if (seconds / 3600 >= 1) return Math.floor(seconds / 3600) + " hours";
  if (seconds / 60 >= 1) return Math.floor(seconds / 60) + " minutes";
  return seconds + " seconds";
}

// Returns null when the array is empty (no data ≠ 0ms latency)
function safeMax(values) {
  if (values.length === 0) return null;
  return Math.max(...values);
}

// ---------------------------------------------------------------------------
// Notifications (ntfy.sh)
// ---------------------------------------------------------------------------

let isInternetDown = false;
let outageStart = null;
let lastReportMs = 0;

async function sendNtfy(title, message) {
  try {
    await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: "POST",
      headers: { "Title": title, "Priority": "high", "Tags": "warning" },
      body: message,
    });
  } catch (err) {
    console.error("Failed to send ntfy notification:", err);
  }
}

function handleConnectivityChange(alive) {
  if (!alive && !isInternetDown) {
    isInternetDown = true;
    outageStart = Date.now();
    sendNtfy("Internet is down", "Both Google and GitHub are unreachable.");
    console.log("Internet DOWN — notification sent.");
  } else if (alive && isInternetDown) {
    isInternetDown = false;
    const duration = outageStart ? Math.round((Date.now() - outageStart) / 1000) : 0;
    sendNtfy("Internet is back", `Connection restored after ${duration}s.`);
    console.log(`Internet UP — was down for ${duration}s, notification sent.`);
    outageStart = null;
  }
}

// ---------------------------------------------------------------------------
// Ping loop
// ---------------------------------------------------------------------------

function pingGoogle() {
  ping.promise
    .probe("google.com")
    .then((result) => {
      if (!result.alive) {
        ping.promise.probe("github.com").then((retryResult) => {
          console.log("Google is not alive. Retrying once with github...", retryResult.alive);
          uptimeHistory.push({
            alive: retryResult.alive,
            time: null, // don't record GitHub response time — it's a different host
            packetLoss: retryResult.packetLoss ? parseFloat(retryResult.packetLoss) : null,
            timestamp: Date.now(),
            retry: true,
          });
          handleConnectivityChange(retryResult.alive);
          maybeReport();
        }).catch((error) => {
          console.error("Error pinging GitHub (retry):", error);
          uptimeHistory.push({
            alive: false,
            time: null,
            packetLoss: 100,
            timestamp: Date.now(),
            retry: true,
          });
          handleConnectivityChange(false);
        });
      } else {
        handleConnectivityChange(true);
        uptimeHistory.push({
          alive: result.alive,
          time: result.time,
          packetLoss: result.packetLoss ? parseFloat(result.packetLoss) : null,
          timestamp: Date.now(),
          retry: false,
        });
        maybeReport();
      }
    })
    .catch((error) => {
      console.error("Error pinging Google:", error);
      // Record the failure so it's reflected in metrics and triggers notifications
      uptimeHistory.push({
        alive: false,
        time: null,
        packetLoss: 100,
        timestamp: Date.now(),
        retry: false,
      });
      handleConnectivityChange(false);
    });
}

function maybeReport() {
  const totalMs = totalMonitoredMs + (Date.now() - appStartTime);
  if (totalMs - lastReportMs >= 28800 * 1000) {
    lastReportMs = totalMs;
    sendMonitoringReport();
  }
}

setInterval(pingGoogle, PING_INTERVAL);

// ---------------------------------------------------------------------------
// Aggregation (every 4 hours)
// ---------------------------------------------------------------------------

function clearHistoryAndUpdateAggregates() {
  // Primary pings only (non-retry, alive) are used for response time metrics
  const alivePrimary = uptimeHistory.filter(r => r.alive && !r.retry && r.time);
  const avgRT = calculateAverageResponseTime(uptimeHistory);
  const maxResponseTime = safeMax(alivePrimary.map(r => r.time)) ?? 0;
  const chunkStart = uptimeHistory.length > 0 ? uptimeHistory[0].timestamp : Date.now();
  const chunkEnd = uptimeHistory.length > 0 ? uptimeHistory[uptimeHistory.length - 1].timestamp : Date.now();

  aggregates.push({
    day: aggregates.length + 1,
    chunkStartTime: chunkStart,
    chunkEndTime: chunkEnd,
    // Display fields (keep for UI table)
    uptime: calculateUptimePercentage(uptimeHistory),
    probes: uptimeHistory.filter(res => !res.retry).length,
    retries: uptimeHistory.filter(res => res.retry).length,
    averageResponseTime: avgRT,
    maxResponseTime,
    averagePacketLoss: calculateAveragePacketLoss(uptimeHistory),
    averageDeviation: calculateResponseTimeDeviation(uptimeHistory),
    // Raw counts for correct weighted averages across chunks
    successfulProbes: uptimeHistory.filter(r => r.alive).length,
    totalProbesCount: uptimeHistory.length,
    totalResponseTime: alivePrimary.reduce((s, r) => s + r.time, 0),
    alivePrimaryCount: alivePrimary.length,
    totalPacketLossSum: uptimeHistory.reduce((s, r) => s + (r.alive ? (r.packetLoss ?? 0) : 100), 0),
    totalDeviationSum: alivePrimary.reduce((s, r) => s + Math.abs(r.time - avgRT), 0),
  });
  uptimeHistory.length = 0;
  console.log("Aggregates updated:", aggregates.length, "chunks");
  // Save immediately after aggregating — this data is valuable
  saveState();
}

setInterval(clearHistoryAndUpdateAggregates, 14400000);

// ---------------------------------------------------------------------------
// Metric calculations (live history)
// ---------------------------------------------------------------------------

function getLastNUptime(hours) {
  const startTime = Date.now() - (hours * 60 * 60 * 1000);
  return uptimeHistory.filter(res => res.timestamp >= startTime);
}

function getLastHourUptime() { return getLastNUptime(1); }
function getLast10MinutesUptime() { return getLastNUptime(10 / 60); }

function calculateUptimePercentage(pingResults) {
  if (pingResults.length === 0) return 0;
  const successfulPings = pingResults.filter(r => r.alive).length;
  return (successfulPings / pingResults.length) * 100;
}

// Only uses primary (non-retry) pings so GitHub latency doesn't pollute Google metrics
function calculateAverageResponseTime(pingResults) {
  const alivePings = pingResults.filter(r => r.alive && !r.retry && r.time);
  if (alivePings.length === 0) return 0;
  const total = alivePings.reduce((acc, r) => acc + r.time, 0);
  return total / alivePings.length;
}

function calculateAveragePacketLoss(pingResults) {
  if (pingResults.length === 0) return 0;
  const total = pingResults.reduce((acc, r) => {
    if (!r.alive) return acc + 100;
    return acc + (r.packetLoss ?? 0);
  }, 0);
  return total / pingResults.length;
}

// Only uses primary (non-retry) pings for the same reason as above
function calculateResponseTimeDeviation(pingResults) {
  const alivePings = pingResults.filter(r => r.alive && !r.retry && r.time);
  if (alivePings.length === 0) return 0;
  const avg = calculateAverageResponseTime(pingResults);
  const totalDev = alivePings.reduce((acc, r) => acc + Math.abs(r.time - avg), 0);
  return totalDev / alivePings.length;
}

// ---------------------------------------------------------------------------
// Weighted metric calculations across chunks + live data
//
// Old chunks (before this fix) lack raw count fields — fall back to
// approximations derived from the stored averages and probe counts.
// ---------------------------------------------------------------------------

function chunkRaw(c) {
  const totalCount = c.totalProbesCount ?? (c.probes + c.retries);
  const aliveCount = c.alivePrimaryCount ?? c.probes;
  return {
    successfulProbes: c.successfulProbes ?? Math.round((c.uptime / 100) * totalCount),
    totalProbesCount: totalCount,
    totalResponseTime: c.totalResponseTime ?? (c.averageResponseTime * aliveCount),
    alivePrimaryCount: aliveCount,
    totalPacketLossSum: c.totalPacketLossSum ?? (c.averagePacketLoss * totalCount),
    totalDeviationSum: c.totalDeviationSum ?? (c.averageDeviation * aliveCount),
    maxResponseTime: c.maxResponseTime ?? 0,
  };
}

function calcUptime(chunks, liveHistory) {
  const hist = chunks.reduce((acc, c) => {
    const r = chunkRaw(c);
    return { successful: acc.successful + r.successfulProbes, total: acc.total + r.totalProbesCount };
  }, { successful: 0, total: 0 });
  const liveSuccessful = liveHistory.filter(r => r.alive).length;
  const total = hist.total + liveHistory.length;
  return total === 0 ? 0 : ((hist.successful + liveSuccessful) / total) * 100;
}

function calcAvgResponseTime(chunks, liveHistory) {
  const hist = chunks.reduce((acc, c) => {
    const r = chunkRaw(c);
    return { totalRT: acc.totalRT + r.totalResponseTime, count: acc.count + r.alivePrimaryCount };
  }, { totalRT: 0, count: 0 });
  const livePrimary = liveHistory.filter(r => r.alive && !r.retry && r.time);
  const liveRT = livePrimary.reduce((s, r) => s + r.time, 0);
  const count = hist.count + livePrimary.length;
  return count === 0 ? 0 : (hist.totalRT + liveRT) / count;
}

function calcMaxResponseTime(chunks, liveHistory) {
  const chunkMaxes = chunks.map(c => chunkRaw(c).maxResponseTime).filter(v => v > 0);
  const liveTimes = liveHistory.filter(r => r.alive && !r.retry && r.time).map(r => r.time);
  return safeMax([...chunkMaxes, ...liveTimes]);
}

function calcAvgPacketLoss(chunks, liveHistory) {
  const hist = chunks.reduce((acc, c) => {
    const r = chunkRaw(c);
    return { totalPL: acc.totalPL + r.totalPacketLossSum, count: acc.count + r.totalProbesCount };
  }, { totalPL: 0, count: 0 });
  const livePL = liveHistory.reduce((s, r) => s + (r.alive ? (r.packetLoss ?? 0) : 100), 0);
  const count = hist.count + liveHistory.length;
  return count === 0 ? 0 : (hist.totalPL + livePL) / count;
}

function calcDeviation(chunks, liveHistory) {
  // Combine all response times to compute a single global average,
  // then calculate mean absolute deviation against that global average.
  // This avoids the inconsistency of summing deviations computed against
  // different per-chunk averages.
  const globalAvg = calcAvgResponseTime(chunks, liveHistory);

  const chunkDev = chunks.reduce((acc, c) => {
    const r = chunkRaw(c);
    if (r.alivePrimaryCount === 0) return acc;
    // Re-derive deviation against global avg using stored chunk average:
    // MAD(chunk, globalAvg) ≈ MAD(chunk, chunkAvg) + |chunkAvg - globalAvg|
    const chunkAvg = r.alivePrimaryCount > 0 ? r.totalResponseTime / r.alivePrimaryCount : 0;
    const adjustedDev = r.totalDeviationSum + r.alivePrimaryCount * Math.abs(chunkAvg - globalAvg);
    return { totalDev: acc.totalDev + adjustedDev, count: acc.count + r.alivePrimaryCount };
  }, { totalDev: 0, count: 0 });

  const livePrimary = liveHistory.filter(r => r.alive && !r.retry && r.time);
  const liveDev = livePrimary.reduce((s, r) => s + Math.abs(r.time - globalAvg), 0);
  const count = chunkDev.count + livePrimary.length;
  return count === 0 ? 0 : (chunkDev.totalDev + liveDev) / count;
}

// ---------------------------------------------------------------------------
// API: uptime data
// ---------------------------------------------------------------------------

app.get("/uptime", (req, res) => {
  const chunks = aggregates.length;
  const last5Chunks = aggregates.slice(Math.max(0, chunks - 5));
  const live = uptimeHistory;
  const lastHour = getLastHourUptime();
  const last10Min = getLast10MinutesUptime();

  // Total monitored time = all previous sessions + current session
  const monitoredMs = totalMonitoredMs + (Date.now() - appStartTime);

  res.json({
    // Short windows — live data only (always within the current 4h window)
    uptimePercentageLast10Minutes: calculateUptimePercentage(last10Min),
    uptimePercentageLastHour: calculateUptimePercentage(lastHour),
    averageResponseTimeLast10Minutes: calculateAverageResponseTime(last10Min),
    averageResponseTimeLastHour: calculateAverageResponseTime(lastHour),
    maxResponseTimeLast10Minutes: safeMax(last10Min.filter(r => r.alive && !r.retry && r.time).map(r => r.time)),
    maxResponseTimeLastHour: safeMax(lastHour.filter(r => r.alive && !r.retry && r.time).map(r => r.time)),
    averagePacketLossLast10Minutes: calculateAveragePacketLoss(last10Min),
    averagePacketLossLastHour: calculateAveragePacketLoss(lastHour),
    responseTimeDeviationLast10Minutes: calculateResponseTimeDeviation(last10Min),
    responseTimeDeviationLastHour: calculateResponseTimeDeviation(lastHour),

    // 24h = weighted across last 5 completed chunks (up to 20h) + current live window
    uptimePercentage24h: calcUptime(last5Chunks, live),
    averageResponseTime24h: calcAvgResponseTime(last5Chunks, live),
    maxResponseTime24h: calcMaxResponseTime(last5Chunks, live),
    averagePacketLoss24h: calcAvgPacketLoss(last5Chunks, live),
    responseTimeDeviation24h: calcDeviation(last5Chunks, live),

    // Lifetime = weighted across all chunks + current live window
    uptimePercentageLifetime: calcUptime(aggregates, live),
    averageResponseTimeLifetime: calcAvgResponseTime(aggregates, live),
    maxResponseTimeLifetime: calcMaxResponseTime(aggregates, live),
    averagePacketLossLifetime: calcAvgPacketLoss(aggregates, live),
    responseTimeDeviationLifetime: calcDeviation(aggregates, live),

    lastUpdated: formatDuration(monitoredMs),
    totalRetries: live.filter(r => r.retry).length + aggregates.reduce((acc, d) => acc + d.retries, 0),
    totalProbes: live.filter(r => !r.retry).length + aggregates.reduce((acc, d) => acc + d.probes, 0),
    aggregates,
  });
});

// ---------------------------------------------------------------------------
// API: clear all data
// ---------------------------------------------------------------------------

app.delete("/data", (req, res) => {
  clearState();
  console.log("All data cleared via API.");
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

function sendMonitoringReport() {
  const live = uptimeHistory;
  const chunks = aggregates.length;
  const last5Chunks = aggregates.slice(Math.max(0, chunks - 5));
  const monitoredMs = totalMonitoredMs + (Date.now() - appStartTime);

  const uptimeReport = `
    <h1>Monitoring Report</h1>
    <p>Uptime percentage (last 24 hours): ${calcUptime(last5Chunks, live).toFixed(5)}%</p>
    <p>Uptime percentage (lifetime): ${calcUptime(aggregates, live).toFixed(5)}%</p>
    <p>Uptime percentage (last hour): ${calculateUptimePercentage(getLastHourUptime()).toFixed(5)}%</p>
    <p>Uptime percentage (last 10 minutes): ${calculateUptimePercentage(getLast10MinutesUptime()).toFixed(5)}%</p>
    <p>Monitored for: ${formatDuration(monitoredMs)}</p>
  `;
  const reportPath = path.join(__dirname, "reports");
  const reportFilePath = path.join(reportPath, `report_${Date.now()}.html`);
  fs.mkdirSync(reportPath, { recursive: true });
  fs.writeFileSync(reportFilePath, uptimeReport);
  console.log("Monitoring report saved:", reportFilePath);
}

// ---------------------------------------------------------------------------
// Static routes — v2 at /, v1 at /v1
// ---------------------------------------------------------------------------

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "v2.html"));
});

app.get("/v1", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
