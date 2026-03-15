import express from "express";
import ping from "ping";
import path from "path";
import fs from "fs";

const app = express();
const PORT = 5555;
const PING_INTERVAL = 5000; // 5 seconds

const uptimeHistory = [];
const aggregates = [];
const appStartTime = Date.now();
const __dirname = path.resolve();

// Bug 8 fix: removed dead `years` assignment; added years branch so >365d displays correctly
function timeSince(date) {
  var seconds = Math.floor((new Date() - date) / 1000);

  var interval = seconds / 31536000;
  if (interval > 1) {
    return Math.floor(interval) + " years";
  }
  interval = seconds / 86400;
  if (interval > 1) {
    return Math.floor(interval) + " days";
  }
  interval = seconds / 3600;
  if (interval > 1) {
    return Math.floor(interval) + " hours";
  }
  interval = seconds / 60;
  if (interval > 1) {
    return Math.floor(interval) + " minutes";
  }
  return Math.floor(seconds) + " seconds";
}

// Bug 1 fix: safe Math.max that returns 0 instead of -Infinity on empty input
function safeMax(values) {
  if (values.length === 0) return 0;
  return Math.max(...values);
}

function pingGoogle() {
  ping.promise
    .probe("google.com")
    .then((result) => {
      if (!result.alive) {
        // Retry once with github
        // Bug 2 fix: added .catch() on the retry promise
        ping.promise.probe("github.com").then((retryResult) => {
          console.log("Google is not alive. Retrying once with github...", retryResult.alive);
          uptimeHistory.push({ alive: retryResult.alive, time: retryResult.time, packetLoss: retryResult.packetLoss ? parseFloat(retryResult.packetLoss) : null, timestamp: Date.now(), retry: true });
          const monitoringTime = Date.now() - appStartTime;
          const monitoringSeconds = Math.floor(monitoringTime / 1000);
          if (monitoringSeconds != 0 && monitoringSeconds % 28800 === 0) {
            sendMonitoringReport();
          }
        }).catch((error) => {
          console.error("Error pinging GitHub (retry):", error);
        });
      } else {
        uptimeHistory.push({ alive: result.alive, time: result.time, packetLoss: result.packetLoss ? parseFloat(result.packetLoss) : null, timestamp: Date.now(), retry: false });
        const monitoringTime = Date.now() - appStartTime;
        const monitoringSeconds = Math.floor(monitoringTime / 1000);
        if (monitoringSeconds != 0 && monitoringSeconds % 28800 === 0) {
          sendMonitoringReport();
        }
      }
    })
    .catch((error) => {
      console.error("Error pinging Google:", error);
    });
}

// Ping Google every 5 seconds
setInterval(pingGoogle, PING_INTERVAL);

// Store aggregates and clear every 4 hours
setInterval(clearHistoryAndUpdateAggregates, 14400000);

// Get the uptime history for the last N hours
function getLastNUptime(hours) {
  const now = Date.now();
  const startTime = now - (hours * 60 * 60 * 1000);
  return uptimeHistory.filter(res => res.timestamp >= startTime);
}

// Calculate the uptime percentage given an array of ping results
function calculateUptimePercentage(pingResults) {
  const totalPings = pingResults.length;
  if (totalPings === 0) return 0;
  const successfulPings = pingResults.filter((result) => result.alive).length;
  return (successfulPings / totalPings) * 100;
}

// Bug 3 fix: divide by number of alive pings, not total pings
function calculateAverageResponseTime(pingResults) {
  const alivePings = pingResults.filter(r => r.alive);
  if (alivePings.length === 0) return 0;
  const totalResponseTime = alivePings.reduce((acc, result) => acc + result.time, 0);
  return totalResponseTime / alivePings.length;
}

// Bug 4 fix: include failed pings (they have 100% packet loss); divide by all pings
function calculateAveragePacketLoss(pingResults) {
  const totalPings = pingResults.length;
  if (totalPings === 0) return 0;
  const totalPacketLoss = pingResults.reduce((acc, result) => {
    if (!result.alive) return acc + 100;
    return acc + (result.packetLoss ?? 0);
  }, 0);
  return totalPacketLoss / totalPings;
}

// Bug 3 fix (deviation): divide by alive pings to match the corrected average calculation
function calculateResponseTimeDeviation(pingResults) {
  const alivePings = pingResults.filter(r => r.alive);
  if (alivePings.length === 0) return 0;
  const averageResponseTime = calculateAverageResponseTime(pingResults);
  const totalDeviation = alivePings.reduce((acc, result) => acc + Math.abs(result.time - averageResponseTime), 0);
  return totalDeviation / alivePings.length;
}

// Get the uptime history for the last hour
function getLastHourUptime() {
  return getLastNUptime(1);
}

// Bug 6 fix: use exact fraction instead of rounded 0.17
function getLast10MinutesUptime() {
  return getLastNUptime(10 / 60);
}

function clearHistoryAndUpdateAggregates() {
  // Bug 1 fix: use safeMax so an empty history doesn't produce -Infinity
  const maxResponseTime = safeMax(uptimeHistory.filter(res => res.alive && res.time).map(res => res.time));
  aggregates.push({
    day: aggregates.length + 1,
    uptime: calculateUptimePercentage(uptimeHistory),
    probes: uptimeHistory.filter(res => !res.retry).length, // Bug 5 fix: only count non-retry pings as probes
    retries: uptimeHistory.filter(res => res.retry).length,
    averageResponseTime: calculateAverageResponseTime(uptimeHistory),
    maxResponseTime,
    averagePacketLoss: calculateAveragePacketLoss(uptimeHistory),
    averageDeviation: calculateResponseTimeDeviation(uptimeHistory),
  });
  uptimeHistory.splice(0, uptimeHistory.length);
  uptimeHistory.length = 0;
  console.log("Aggregates updated:", aggregates);
}



// Uptime endpoint
app.get("/uptime", (req, res) => {

  const chunks = aggregates.length;

  // Bug 7 fix: use last 5 chunks to cover 24h (5 × 4h = 20h + up to 4h current window = 24h)
  // Blend current window with enough past chunks to cover the full 24h span.
  const last24UptimeCalc = chunks >= 5
    ? (calculateUptimePercentage(getLastNUptime(24)) + aggregates.slice(chunks - 5, chunks).reduce((acc, day) => acc + day.uptime, 0) / 5) / 2
    : calculateUptimePercentage(getLastNUptime(24));

  const lifetimeUptimeCalc = chunks >= 5
    ? (calculateUptimePercentage(getLastNUptime(24)) + aggregates.reduce((acc, day) => acc + day.uptime, 0)) / (aggregates.length + 1)
    : calculateUptimePercentage(getLastNUptime(24));

  const uptimePercentage24h = last24UptimeCalc;
  const uptimePercentageLifetime = lifetimeUptimeCalc;
  const uptimePercentageLastHour = calculateUptimePercentage(getLastHourUptime());
  const uptimePercentageLast10Minutes = calculateUptimePercentage(getLast10MinutesUptime());

  // Bug 5 fix: retries are not probes — exclude them from totalProbes
  const totalRetries = uptimeHistory.filter(res => res.retry).length + aggregates.reduce((acc, day) => acc + day.retries, 0);
  const getTotalProbes = uptimeHistory.filter(res => !res.retry).length + aggregates.reduce((acc, day) => acc + day.probes, 0);

  // Bug 7 fix: use last 5 chunks for 24h response time blend
  const averageResponseTime24hCalc = chunks >= 5
    ? (calculateAverageResponseTime(getLastNUptime(24)) + aggregates.slice(chunks - 5, chunks).reduce((acc, day) => acc + day.averageResponseTime, 0) / 5) / 2
    : calculateAverageResponseTime(getLastNUptime(24));
  const averageResponseTimeLifetimeCalc = chunks >= 5
    ? (calculateAverageResponseTime(getLastNUptime(24)) + aggregates.reduce((acc, day) => acc + day.averageResponseTime, 0)) / (aggregates.length + 1)
    : calculateAverageResponseTime(getLastNUptime(24));

  const averageResponseTime24h = averageResponseTime24hCalc;
  const averageResponseTimeLifetime = averageResponseTimeLifetimeCalc;
  const averageResponseTimeLastHour = calculateAverageResponseTime(getLastHourUptime());
  const averageResponseTimeLast10Minutes = calculateAverageResponseTime(getLast10MinutesUptime());

  // Bug 1 fix: use safeMax to avoid -Infinity when arrays are empty
  // Bug 7 fix: use last 5 chunks for 24h max
  const maxResponseTime24hCalc = chunks >= 5
    ? safeMax([
        ...aggregates.slice(chunks - 5, chunks).filter(elem => elem.maxResponseTime).map(elem => elem.maxResponseTime),
        ...getLastNUptime(24).filter(res => res.alive && res.time).map(res => res.time),
      ])
    : safeMax(getLastNUptime(24).filter(res => res.alive && res.time).map(res => res.time));

  const maxResponseTimeLifetimeCalc = safeMax([
    ...aggregates.filter(elem => elem.maxResponseTime).map(elem => elem.maxResponseTime),
    ...uptimeHistory.filter(res => res.alive && res.time).map(res => res.time),
  ]);

  const maxResponseTime24h = maxResponseTime24hCalc;
  const maxResponseTimeLifetime = maxResponseTimeLifetimeCalc;
  const maxResponseTimeLastHour = safeMax(getLastHourUptime().filter(res => res.alive && res.time).map(res => res.time));
  const maxResponseTimeLast10Minutes = safeMax(getLast10MinutesUptime().filter(res => res.alive && res.time).map(res => res.time));

  // Bug 7 fix: use last 5 chunks for 24h packet loss blend
  const averagePacketLoss24hCalc = chunks >= 5
    ? (calculateAveragePacketLoss(getLastNUptime(24)) + aggregates.slice(chunks - 5, chunks).reduce((acc, day) => acc + day.averagePacketLoss, 0) / 5) / 2
    : calculateAveragePacketLoss(getLastNUptime(24));
  const averagePacketLossLifetimeCalc = chunks >= 5
    ? (calculateAveragePacketLoss(getLastNUptime(24)) + aggregates.reduce((acc, day) => acc + day.averagePacketLoss, 0)) / (aggregates.length + 1)
    : calculateAveragePacketLoss(getLastNUptime(24));

  const averagePacketLoss24h = averagePacketLoss24hCalc;
  const averagePacketLossLifetime = averagePacketLossLifetimeCalc;
  const averagePacketLossLastHour = calculateAveragePacketLoss(getLastHourUptime());
  const averagePacketLossLast10Minutes = calculateAveragePacketLoss(getLast10MinutesUptime());

  // Bug 7 fix: use last 5 chunks for 24h deviation blend
  const responseTimeDeviation24hCalc = chunks >= 5
    ? (calculateResponseTimeDeviation(getLastNUptime(24)) + aggregates.slice(chunks - 5, chunks).reduce((acc, day) => acc + day.averageDeviation, 0) / 5) / 2
    : calculateResponseTimeDeviation(getLastNUptime(24));
  const responseTimeDeviationLifetimeCalc = chunks >= 5
    ? (calculateResponseTimeDeviation(getLastNUptime(24)) + aggregates.reduce((acc, day) => acc + day.averageDeviation, 0)) / (aggregates.length + 1)
    : calculateResponseTimeDeviation(getLastNUptime(24));

  const responseTimeDeviation24h = responseTimeDeviation24hCalc;
  const responseTimeDeviationLifetime = responseTimeDeviationLifetimeCalc;
  const responseTimeDeviationLastHour = calculateResponseTimeDeviation(getLastHourUptime());
  const responseTimeDeviationLast10Minutes = calculateResponseTimeDeviation(getLast10MinutesUptime());

  res.json({
    uptimePercentage24h,
    uptimePercentageLifetime,
    uptimePercentageLastHour,
    uptimePercentageLast10Minutes,
    lastUpdated: timeSince(appStartTime),
    totalRetries,
    totalProbes: getTotalProbes,
    aggregates,
    averageResponseTime24h,
    averageResponseTimeLifetime,
    averageResponseTimeLastHour,
    averageResponseTimeLast10Minutes,
    averagePacketLoss24h,
    averagePacketLossLifetime,
    averagePacketLossLastHour,
    averagePacketLossLast10Minutes,
    responseTimeDeviation24h,
    responseTimeDeviationLifetime,
    responseTimeDeviationLastHour,
    responseTimeDeviationLast10Minutes,
    maxResponseTime24h,
    maxResponseTimeLifetime,
    maxResponseTimeLastHour,
    maxResponseTimeLast10Minutes,
  });
});

function sendMonitoringReport() {
  const uptimePercentage24h = calculateUptimePercentage(getLastNUptime(24));
  const uptimePercentageLifetime = calculateUptimePercentage(uptimeHistory);
  const uptimePercentageLastHour = calculateUptimePercentage(getLastHourUptime());
  const uptimePercentageLast10Minutes = calculateUptimePercentage(getLast10MinutesUptime());
  const uptimeReport = `
    <h1>Monitoring Report</h1>
    <p>Uptime percentage (last 24 hours): ${uptimePercentage24h}%</p>
    <p>Uptime percentage (lifetime): ${uptimePercentageLifetime}%</p>
    <p>Uptime percentage (last hour): ${uptimePercentageLastHour}%</p>
    <p>Uptime percentage (last 10 minutes): ${uptimePercentageLast10Minutes}%</p>
    <p>Monitored for: ${timeSince(appStartTime)}</p>
  `;

  const reportPath = path.join(__dirname, "reports");
  const reportFileName = `report_${Date.now()}.html`;
  const reportFilePath = path.join(reportPath, reportFileName);

  fs.mkdirSync(reportPath, { recursive: true });
  fs.writeFileSync(reportFilePath, uptimeReport);

  console.log("Monitoring report saved:", reportFilePath);
}

// v2 UI at root, v1 at /v1 (must be before static middleware)
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "v2.html"));
});

app.get("/v1", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Set the public folder as a static directory
app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
