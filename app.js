import express from "express";
import ping from "ping";
import path from "path";
import fs from "fs";

const app = express();
const PORT = 5555;
const PING_INTERVAL = 5000; // 5 seconds

const __dirname = path.resolve();
const DATA_FILE = path.join(__dirname, "data", "state.json");

// ---------------------------------------------------------------------------
// In-memory state — loaded from disk on startup
// ---------------------------------------------------------------------------

let uptimeHistory = [];
let aggregates = [];
let appStartTime = Date.now();

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
    fs.writeFileSync(DATA_FILE, JSON.stringify({ appStartTime, aggregates, uptimeHistory }));
  } catch (err) {
    console.error("Failed to save state to disk:", err);
  }
}

function clearState() {
  uptimeHistory.length = 0;
  aggregates.length = 0;
  appStartTime = Date.now();
  try {
    fs.rmSync(DATA_FILE, { force: true });
  } catch (err) {
    console.error("Failed to delete state file:", err);
  }
}

// Load persisted state before anything else
loadState();

// Save history every 60 seconds so we lose at most ~1 min of pings on an unclean exit
setInterval(saveState, 60000);

// Save on clean shutdown
process.on("SIGINT", () => { saveState(); process.exit(0); });
process.on("SIGTERM", () => { saveState(); process.exit(0); });

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function timeSince(date) {
  const seconds = Math.floor((Date.now() - date) / 1000);

  let interval = seconds / 31536000;
  if (interval > 1) return Math.floor(interval) + " years";

  interval = seconds / 86400;
  if (interval > 1) return Math.floor(interval) + " days";

  interval = seconds / 3600;
  if (interval > 1) return Math.floor(interval) + " hours";

  interval = seconds / 60;
  if (interval > 1) return Math.floor(interval) + " minutes";

  return Math.floor(seconds) + " seconds";
}

// Returns 0 instead of -Infinity when the array is empty
function safeMax(values) {
  if (values.length === 0) return 0;
  return Math.max(...values);
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
            time: retryResult.time,
            packetLoss: retryResult.packetLoss ? parseFloat(retryResult.packetLoss) : null,
            timestamp: Date.now(),
            retry: true,
          });
          maybeReport();
        }).catch((error) => {
          console.error("Error pinging GitHub (retry):", error);
        });
      } else {
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
    });
}

function maybeReport() {
  const monitoringSeconds = Math.floor((Date.now() - appStartTime) / 1000);
  if (monitoringSeconds !== 0 && monitoringSeconds % 28800 === 0) {
    sendMonitoringReport();
  }
}

setInterval(pingGoogle, PING_INTERVAL);

// ---------------------------------------------------------------------------
// Aggregation (every 4 hours)
// ---------------------------------------------------------------------------

function clearHistoryAndUpdateAggregates() {
  const maxResponseTime = safeMax(uptimeHistory.filter(res => res.alive && res.time).map(res => res.time));
  aggregates.push({
    day: aggregates.length + 1,
    uptime: calculateUptimePercentage(uptimeHistory),
    probes: uptimeHistory.filter(res => !res.retry).length,
    retries: uptimeHistory.filter(res => res.retry).length,
    averageResponseTime: calculateAverageResponseTime(uptimeHistory),
    maxResponseTime,
    averagePacketLoss: calculateAveragePacketLoss(uptimeHistory),
    averageDeviation: calculateResponseTimeDeviation(uptimeHistory),
  });
  uptimeHistory.length = 0;
  console.log("Aggregates updated:", aggregates);
  // Save immediately after aggregating — this data is valuable
  saveState();
}

setInterval(clearHistoryAndUpdateAggregates, 14400000);

// ---------------------------------------------------------------------------
// Metric calculations
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

function calculateAverageResponseTime(pingResults) {
  const alivePings = pingResults.filter(r => r.alive);
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

function calculateResponseTimeDeviation(pingResults) {
  const alivePings = pingResults.filter(r => r.alive);
  if (alivePings.length === 0) return 0;
  const avg = calculateAverageResponseTime(pingResults);
  const totalDev = alivePings.reduce((acc, r) => acc + Math.abs(r.time - avg), 0);
  return totalDev / alivePings.length;
}

// ---------------------------------------------------------------------------
// API: uptime data
// ---------------------------------------------------------------------------

app.get("/uptime", (req, res) => {
  const chunks = aggregates.length;

  // Use last 5 chunks (5 × 4h = 20h) + current window to cover a full 24h span
  const last24UptimeCalc = chunks >= 5
    ? (calculateUptimePercentage(getLastNUptime(24)) + aggregates.slice(chunks - 5, chunks).reduce((acc, d) => acc + d.uptime, 0) / 5) / 2
    : calculateUptimePercentage(getLastNUptime(24));

  const lifetimeUptimeCalc = chunks >= 5
    ? (calculateUptimePercentage(getLastNUptime(24)) + aggregates.reduce((acc, d) => acc + d.uptime, 0)) / (chunks + 1)
    : calculateUptimePercentage(getLastNUptime(24));

  const averageResponseTime24hCalc = chunks >= 5
    ? (calculateAverageResponseTime(getLastNUptime(24)) + aggregates.slice(chunks - 5, chunks).reduce((acc, d) => acc + d.averageResponseTime, 0) / 5) / 2
    : calculateAverageResponseTime(getLastNUptime(24));

  const averageResponseTimeLifetimeCalc = chunks >= 5
    ? (calculateAverageResponseTime(getLastNUptime(24)) + aggregates.reduce((acc, d) => acc + d.averageResponseTime, 0)) / (chunks + 1)
    : calculateAverageResponseTime(getLastNUptime(24));

  const maxResponseTime24hCalc = chunks >= 5
    ? safeMax([
        ...aggregates.slice(chunks - 5, chunks).filter(e => e.maxResponseTime).map(e => e.maxResponseTime),
        ...getLastNUptime(24).filter(r => r.alive && r.time).map(r => r.time),
      ])
    : safeMax(getLastNUptime(24).filter(r => r.alive && r.time).map(r => r.time));

  const averagePacketLoss24hCalc = chunks >= 5
    ? (calculateAveragePacketLoss(getLastNUptime(24)) + aggregates.slice(chunks - 5, chunks).reduce((acc, d) => acc + d.averagePacketLoss, 0) / 5) / 2
    : calculateAveragePacketLoss(getLastNUptime(24));

  const averagePacketLossLifetimeCalc = chunks >= 5
    ? (calculateAveragePacketLoss(getLastNUptime(24)) + aggregates.reduce((acc, d) => acc + d.averagePacketLoss, 0)) / (chunks + 1)
    : calculateAveragePacketLoss(getLastNUptime(24));

  const responseTimeDeviation24hCalc = chunks >= 5
    ? (calculateResponseTimeDeviation(getLastNUptime(24)) + aggregates.slice(chunks - 5, chunks).reduce((acc, d) => acc + d.averageDeviation, 0) / 5) / 2
    : calculateResponseTimeDeviation(getLastNUptime(24));

  const responseTimeDeviationLifetimeCalc = chunks >= 5
    ? (calculateResponseTimeDeviation(getLastNUptime(24)) + aggregates.reduce((acc, d) => acc + d.averageDeviation, 0)) / (chunks + 1)
    : calculateResponseTimeDeviation(getLastNUptime(24));

  res.json({
    uptimePercentage24h: last24UptimeCalc,
    uptimePercentageLifetime: lifetimeUptimeCalc,
    uptimePercentageLastHour: calculateUptimePercentage(getLastHourUptime()),
    uptimePercentageLast10Minutes: calculateUptimePercentage(getLast10MinutesUptime()),
    lastUpdated: timeSince(appStartTime),
    totalRetries: uptimeHistory.filter(r => r.retry).length + aggregates.reduce((acc, d) => acc + d.retries, 0),
    totalProbes: uptimeHistory.filter(r => !r.retry).length + aggregates.reduce((acc, d) => acc + d.probes, 0),
    aggregates,
    averageResponseTime24h: averageResponseTime24hCalc,
    averageResponseTimeLifetime: averageResponseTimeLifetimeCalc,
    averageResponseTimeLastHour: calculateAverageResponseTime(getLastHourUptime()),
    averageResponseTimeLast10Minutes: calculateAverageResponseTime(getLast10MinutesUptime()),
    averagePacketLoss24h: averagePacketLoss24hCalc,
    averagePacketLossLifetime: averagePacketLossLifetimeCalc,
    averagePacketLossLastHour: calculateAveragePacketLoss(getLastHourUptime()),
    averagePacketLossLast10Minutes: calculateAveragePacketLoss(getLast10MinutesUptime()),
    responseTimeDeviation24h: responseTimeDeviation24hCalc,
    responseTimeDeviationLifetime: responseTimeDeviationLifetimeCalc,
    responseTimeDeviationLastHour: calculateResponseTimeDeviation(getLastHourUptime()),
    responseTimeDeviationLast10Minutes: calculateResponseTimeDeviation(getLast10MinutesUptime()),
    maxResponseTime24h: maxResponseTime24hCalc,
    maxResponseTimeLifetime: safeMax([
      ...aggregates.filter(e => e.maxResponseTime).map(e => e.maxResponseTime),
      ...uptimeHistory.filter(r => r.alive && r.time).map(r => r.time),
    ]),
    maxResponseTimeLastHour: safeMax(getLastHourUptime().filter(r => r.alive && r.time).map(r => r.time)),
    maxResponseTimeLast10Minutes: safeMax(getLast10MinutesUptime().filter(r => r.alive && r.time).map(r => r.time)),
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
  const uptimeReport = `
    <h1>Monitoring Report</h1>
    <p>Uptime percentage (last 24 hours): ${calculateUptimePercentage(getLastNUptime(24))}%</p>
    <p>Uptime percentage (lifetime): ${calculateUptimePercentage(uptimeHistory)}%</p>
    <p>Uptime percentage (last hour): ${calculateUptimePercentage(getLastHourUptime())}%</p>
    <p>Uptime percentage (last 10 minutes): ${calculateUptimePercentage(getLast10MinutesUptime())}%</p>
    <p>Monitored for: ${timeSince(appStartTime)}</p>
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
