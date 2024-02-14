const express = require("express");
const ping = require("ping");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = 5555;
const PING_INTERVAL = 5000; // 5 seconds

const uptimeHistory = [];
const aggregates = [];
const appStartTime = Date.now();

function timeSince(date) {
  var seconds = Math.floor((new Date() - date) / 1000);

  var interval = seconds / 31536000;

  if (interval > 1) {
    return Math.floor(interval) + " years";
  }
  interval = seconds / 2592000;
  if (interval > 1) {
    return Math.floor(interval) + " months";
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

function pingGoogle() {
  ping.promise
    .probe("google.com")
    .then((result) => {
      if (!result.alive) {
        // Retry once
        ping.promise.probe("github.com").then((retryResult) => {
          console.log("Google is not alive. Retrying once with github...", retryResult.alive);
          uptimeHistory.push({ alive: retryResult.alive, time: retryResult.time, packetLoss: parseFloat(retryResult.packetLoss), timestamp: Date.now(), retry: true});
          const monitoringTime = Date.now() - appStartTime;
          const monitoringSeconds = Math.floor(monitoringTime / 1000);

          if (monitoringSeconds != 0 && monitoringSeconds % 28800 === 0) {
            sendMonitoringReport();
          }
        });
      } else {
        uptimeHistory.push({ alive: result.alive, time: result.time, packetLoss: parseFloat(result.packetLoss), timestamp: Date.now(), retry: false });

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
  const successfulPings = pingResults.filter((result) => result.alive).length;

  if (totalPings === 0) {
    return 0; // No pings yet, so uptime percentage is 0
  }

  return (successfulPings / totalPings) * 100;
}

// Calculate the average response time given an array of ping results
function calculateAverageResponseTime(pingResults) {
  const totalPings = pingResults.length;
  const totalResponseTime = pingResults.reduce((acc, result) => acc + result.time, 0);

  if (totalPings === 0) {
    return 0; // No pings yet, so average response time is 0
  }

  return totalResponseTime / totalPings;
}

// Calculate the average packet loss given an array of ping results
function calculateAveragePacketLoss(pingResults) {
  const totalPings = pingResults.length;
  const totalPacketLoss = pingResults.reduce((acc, result) => acc + result.packetLoss, 0);

  if (totalPings === 0) {
    return 0; // No pings yet, so average packet loss is 0
  }
  return totalPacketLoss / totalPings;
}

// Calculate the deviation of the response time given an array of ping results
function calculateResponseTimeDeviation(pingResults) {
  const totalPings = pingResults.length;
  const averageResponseTime = calculateAverageResponseTime(pingResults);
  const totalResponseTimeDeviation = pingResults.reduce((acc, result) => acc + Math.abs(result.time - averageResponseTime), 0);

  if (totalPings === 0) {
    return 0; // No pings yet, so response time deviation is 0
  }

  return totalResponseTimeDeviation / totalPings;
}

// Get the uptime history for the last hour
function getLastHourUptime() {
  return getLastNUptime(1);
}

// Get the uptime history for the last 10 minutes
function getLast10MinutesUptime() {
  return getLastNUptime(0.17); // 0.17 hours = 10 minutes
}

function clearHistoryAndUpdateAggregates() {
  aggregates.push({
    day: aggregates.length + 1,
    uptime: calculateUptimePercentage(uptimeHistory),
    probes: uptimeHistory.length,
    retries: uptimeHistory.filter(res => res.retry).length
  })
  uptimeHistory.length = 0;
  console.log("Aggregates updated:", aggregates);
}

// Uptime endpoint
app.get("/uptime", (req, res) => {
  const uptimePercentage24h = calculateUptimePercentage(getLastNUptime(24));
  const uptimePercentageLifetime = calculateUptimePercentage(uptimeHistory);
  const uptimePercentageLastHour = calculateUptimePercentage(getLastHourUptime());
  const uptimePercentageLast10Minutes = calculateUptimePercentage(getLast10MinutesUptime());
  const totalRetries = uptimeHistory.filter(res => res.retry).length + aggregates.reduce((acc, day) => acc + day.retries, 0);;
  const getTotalProbes = uptimeHistory.length + aggregates.reduce((acc, day) => acc + day.probes, 0);

  const averageResponseTime24h = calculateAverageResponseTime(getLastNUptime(24));
  const averageResponseTimeLifetime = calculateAverageResponseTime(uptimeHistory);
  const averageResponseTimeLastHour = calculateAverageResponseTime(getLastHourUptime());
  const averageResponseTimeLast10Minutes = calculateAverageResponseTime(getLast10MinutesUptime());

  const maxResponseTime24h = Math.max(...getLastNUptime(24).map(res => res.time));
  const maxResponseTimeLifetime = Math.max(...uptimeHistory.map(res => res.time));
  const maxResponseTimeLastHour = Math.max(...getLastHourUptime().map(res => res.time));
  const maxResponseTimeLast10Minutes = Math.max(...getLast10MinutesUptime().map(res => res.time));

  const averagePacketLoss24h = calculateAveragePacketLoss(getLastNUptime(24));
  const averagePacketLossLifetime = calculateAveragePacketLoss(uptimeHistory);
  const averagePacketLossLastHour = calculateAveragePacketLoss(getLastHourUptime());
  const averagePacketLossLast10Minutes = calculateAveragePacketLoss(getLast10MinutesUptime());

  const responseTimeDeviation24h = calculateResponseTimeDeviation(getLastNUptime(24));
  const responseTimeDeviationLifetime = calculateResponseTimeDeviation(uptimeHistory);
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
    maxResponseTimeLast10Minutes  
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

// Set the public folder as a static directory
app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
