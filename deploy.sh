#!/bin/bash
sudo systemctl restart uptime-monitor.service
echo 'Restarted. Logs:'
tail -20 ~/uptime-monitor-app/output.log
