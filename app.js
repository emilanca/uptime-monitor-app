const express = require("express");
const ping = require("ping");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = 3000;
const PING_INTERVAL = 5000; // 5 seconds
const MAX_HISTORY = (24 * 60 * 60 * 1000) / PING_INTERVAL; // Number of pings to keep in history for 24 hours

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
      uptimeHistory.push(result.alive);
      if (uptimeHistory.length > MAX_HISTORY) {
        uptimeHistory.shift(); // Remove the oldest ping result if exceeding the maximum history length
      }

      const monitoringTime = Date.now() - appStartTime;
      const monitoringMinutes = Math.floor(monitoringTime / 1000 * 60);

      if (monitoringMinutes % 180 === 0) {
        sendMonitoringReport();
      }

    })
    .catch((error) => {
      console.error("Error pinging Google:", error);
    });
}

// Ping Google every 5 seconds
setInterval(pingGoogle, PING_INTERVAL);

// Uptime endpoint
app.get("/uptime", (req, res) => {
  const uptimePercentage24h = calculateUptimePercentage(getLast24HoursUptime());
  const uptimePercentageLifetime = calculateUptimePercentage(uptimeHistory);

  res.json({
    uptimePercentage24h,
    uptimePercentageLifetime,
    lastUpdated: timeSince(appStartTime),
  });
});

// Get the uptime history for the last 24 hours
function getLast24HoursUptime() {
  const now = Date.now();
  const startTime = now - MAX_HISTORY * PING_INTERVAL;
  const startIndex = Math.max(0, Math.floor((startTime - now) / PING_INTERVAL));

  return uptimeHistory.slice(startIndex);
}

// Calculate the uptime percentage given an array of ping results
function calculateUptimePercentage(pingResults) {
  const totalPings = pingResults.length;
  const successfulPings = pingResults.filter((result) => result).length;

  if (totalPings === 0) {
    return 0; // No pings yet, so uptime percentage is 0
  }

  return (successfulPings / totalPings) * 100;
}

function sendMonitoringReport() {
  const uptimePercentage24h = calculateUptimePercentage(getLast24HoursUptime());
  const uptimePercentageLifetime = calculateUptimePercentage(uptimeHistory);
  const uptimeReport = `
    <h1>Monitoring Report</h1>
    <p>Uptime percentage (last 24 hours): ${uptimePercentage24h}%</p>
    <p>Uptime percentage (lifetime): ${uptimePercentageLifetime}%</p>
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
