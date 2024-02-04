const express = require("express");
const ping = require("ping");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = 5555;
const PING_INTERVAL = 5000; // 5 seconds

const uptimeHistory = [];
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
          uptimeHistory.push({ alive: retryResult.alive, timestamp: Date.now(), retry: true});

          const monitoringTime = Date.now() - appStartTime;
          const monitoringSeconds = Math.floor(monitoringTime / 1000);

          if (monitoringSeconds != 0 && monitoringSeconds % 28800 === 0) {
            sendMonitoringReport();
          }
        });
      } else {
        uptimeHistory.push({ alive: result.alive, timestamp: Date.now(), retry: false });

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

// Get the uptime history for the last hour
function getLastHourUptime() {
  return getLastNUptime(1);
}

// Get the uptime history for the last 10 minutes
function getLast10MinutesUptime() {
  return getLastNUptime(0.17); // 0.17 hours = 10 minutes
}

// Uptime endpoint
app.get("/uptime", (req, res) => {
  const uptimePercentage24h = calculateUptimePercentage(getLastNUptime(24));
  const uptimePercentageLifetime = calculateUptimePercentage(uptimeHistory);
  const uptimePercentageLastHour = calculateUptimePercentage(getLastHourUptime());
  const uptimePercentageLast10Minutes = calculateUptimePercentage(getLast10MinutesUptime());
  const totalRetries = uptimeHistory.filter(res => res.retry).length;
  const getTotalProbes = uptimeHistory.length;

  res.json({
    uptimePercentage24h,
    uptimePercentageLifetime,
    uptimePercentageLastHour,
    uptimePercentageLast10Minutes,
    lastUpdated: timeSince(appStartTime),
    totalRetries,
    totalProbes: getTotalProbes
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
