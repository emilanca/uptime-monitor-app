const express = require("express");
const ping = require("ping");
const path = require("path");

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

// Set the public folder as a static directory
app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
