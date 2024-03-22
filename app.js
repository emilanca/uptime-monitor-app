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
          uptimeHistory.push({ alive: retryResult.alive, time: retryResult.time, packetLoss: retryResult.packetLoss? parseFloat(retryResult.packetLoss) : null, timestamp: Date.now(), retry: true});
          const monitoringTime = Date.now() - appStartTime;
          const monitoringSeconds = Math.floor(monitoringTime / 1000);

          if (monitoringSeconds != 0 && monitoringSeconds % 28800 === 0) {
            sendMonitoringReport();
          }
        });
      } else {
        uptimeHistory.push({ alive: result.alive, time: result.time, packetLoss: result.packetLoss? parseFloat(result.packetLoss) : null, timestamp: Date.now(), retry: false });

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
  const totalResponseTime = pingResults.filter(r => r.alive).reduce((acc, result) => acc + result.time, 0);

  if (totalPings === 0) {
    return 0; // No pings yet, so average response time is 0
  }

  return totalResponseTime / totalPings;
}

// Calculate the average packet loss given an array of ping results
function calculateAveragePacketLoss(pingResults) {
  const totalPings = pingResults.length;
  const totalPacketLoss = pingResults.filter(r => r.alive).reduce((acc, result) => acc + result.packetLoss, 0);

  if (totalPings === 0) {
    return 0; // No pings yet, so average packet loss is 0
  }
  return totalPacketLoss / totalPings;
}

// Calculate the deviation of the response time given an array of ping results
function calculateResponseTimeDeviation(pingResults) {
  const totalPings = pingResults.length;
  const averageResponseTime = calculateAverageResponseTime(pingResults);
  const totalResponseTimeDeviation = pingResults.filter(r => r.alive).reduce((acc, result) => acc + Math.abs(result.time - averageResponseTime), 0);

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
  const maxResponseTime = Math.max(...uptimeHistory.filter(res => res.time).map(res => res.time));
  aggregates.push({
    day: aggregates.length + 1,
    uptime: calculateUptimePercentage(uptimeHistory),
    probes: uptimeHistory.length,
    retries: uptimeHistory.filter(res => res.retry).length,
    averageResponseTime: calculateAverageResponseTime(uptimeHistory),
    maxResponseTime: maxResponseTime? maxResponseTime : 0.00,
    averagePacketLoss: calculateAveragePacketLoss(uptimeHistory),
    averageDeviation: calculateResponseTimeDeviation(uptimeHistory)

  })
  uptimeHistory.splice(0, uptimeHistory.length);
  uptimeHistory.length = 0;
  console.log("Aggregates updated:", aggregates);
}



// Uptime endpoint
app.get("/uptime", (req, res) => {

  const chunks = aggregates.length

  // average on using the aggregates. not 100% acurate as assumes all chunks are equal and the non aggregates might be not
  const last24UptimeCalc = chunks >= 4 ? (calculateUptimePercentage(getLastNUptime(24)) + aggregates.slice(chunks - 3, chunks).reduce((acc, day) => acc + day.uptime, 0) / 3) / 2
    : calculateUptimePercentage(getLastNUptime(24));
    const lifetimeUptimeCalc = chunks >= 4 ? (calculateUptimePercentage(getLastNUptime(24)) + aggregates.reduce((acc, day) => acc + day.uptime, 0)) / (aggregates.length + 1) 
  : calculateUptimePercentage(getLastNUptime(24));

  const uptimePercentage24h = last24UptimeCalc
  const uptimePercentageLifetime = lifetimeUptimeCalc;
  const uptimePercentageLastHour = calculateUptimePercentage(getLastHourUptime());
  const uptimePercentageLast10Minutes = calculateUptimePercentage(getLast10MinutesUptime());
  const totalRetries = uptimeHistory.filter(res => res.retry).length + aggregates.reduce((acc, day) => acc + day.retries, 0);;
  const getTotalProbes = uptimeHistory.length + aggregates.reduce((acc, day) => acc + day.probes, 0);

  
  // average on using the aggregates. not 100% acurate as assumes all chunks are equal and the non aggrregate might be not
  const averageResponseTime24hCalc = chunks >= 4 ? (calculateAverageResponseTime(getLastNUptime(24)) + aggregates.slice(chunks - 3, chunks).reduce((acc, day) => acc + day.averageResponseTime, 0) / 3) / 2
    : calculateAverageResponseTime(getLastNUptime(24));
  const averageResponseTimeLifetimeCalc = chunks >= 4 ? (calculateAverageResponseTime(getLastNUptime(24)) + aggregates.reduce((acc, day) => acc + day.averageResponseTime, 0)) / (aggregates.length + 1) 
    : calculateAverageResponseTime(getLastNUptime(24));
  

  const averageResponseTime24h = averageResponseTime24hCalc;
  const averageResponseTimeLifetime = averageResponseTimeLifetimeCalc;
  const averageResponseTimeLastHour = calculateAverageResponseTime(getLastHourUptime());
  const averageResponseTimeLast10Minutes = calculateAverageResponseTime(getLast10MinutesUptime());

  const maxResponseTime24hCalc = chunks >= 4 ? Math.max(...aggregates.slice(chunks - 3, chunks).filter(elem => elem.maxResponseTime).map(elem => elem.maxResponseTime), ...getLastNUptime(24).filter(res => res.time).map(res => res.time)) : Math.max(...getLastNUptime(24).filter(res => res.time).map(res => res.time));
  const maxResponseTimeLifetimeCalc = Math.max(...aggregates.filter(elem => elem.maxResponseTime).map(elem => elem.maxResponseTime), ...uptimeHistory.filter(res => res.time).map(res => res.time));

  const maxResponseTime24h = maxResponseTime24hCalc;
  const maxResponseTimeLifetime = maxResponseTimeLifetimeCalc
  const maxResponseTimeLastHour = Math.max(...getLastHourUptime().filter(res => res.time).map(res => res.time));
  const maxResponseTimeLast10Minutes = Math.max(...getLast10MinutesUptime().filter(res => res.time).map(res => res.time));


  // average on using the aggregates. not 100% acurate as assumes all chunks are equal and the non aggrregate might be not
  const averagePacketLoss24hCalc = chunks >= 4 ? (calculateAveragePacketLoss(getLastNUptime(24)) + aggregates.slice(chunks - 3, chunks).reduce((acc, day) => acc + day.averagePacketLoss, 0) / 3) / 2
    : calculateAveragePacketLoss(getLastNUptime(24));
  const averagePacketLossLifetimeCalc = chunks >= 4 ? (calculateAveragePacketLoss(getLastNUptime(24)) + aggregates.reduce((acc, day) => acc + day.averagePacketLoss, 0))/ (aggregates.length + 1) 
    : calculateAveragePacketLoss(getLastNUptime(24));
    
  const averagePacketLoss24h = averagePacketLoss24hCalc;
  const averagePacketLossLifetime = averagePacketLossLifetimeCalc;
  const averagePacketLossLastHour = calculateAveragePacketLoss(getLastHourUptime());
  const averagePacketLossLast10Minutes = calculateAveragePacketLoss(getLast10MinutesUptime());

  // average on using the aggregates. not 100% acurate as assumes all chunks are equal and the non aggrregate might be not
  const responseTimeDeviation24hCalc = chunks >= 4 ? (calculateResponseTimeDeviation(getLastNUptime(24)) + aggregates.slice(chunks - 3, chunks).reduce((acc, day) => acc + day.averageDeviation, 0) / 3) / 2
    : calculateResponseTimeDeviation(getLastNUptime(24));
  const responseTimeDeviationLifetimeCalc = chunks >= 4 ? (calculateResponseTimeDeviation(getLastNUptime(24)) + aggregates.reduce((acc, day) => acc + day.averageDeviation, 0)) / (aggregates.length + 1) 
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
