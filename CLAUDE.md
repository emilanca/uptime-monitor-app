# Uptime Monitor App

Internet uptime monitoring app running on a Raspberry Pi, accessible at `http://raspberrypi.local:5555/`.

## Stack
- Node.js (v25.8.1 via nvm) + Express
- Pings google.com every 5s, falls back to github.com on failure
- Push notifications via ntfy.sh topic `emil-internet-925`

## Deployment (Raspberry Pi)

**SSH:** `emilanca@raspberrypi-925` — use `plink` (PuTTY), not sshpass
```bash
plink -ssh emilanca@raspberrypi-925 -pw 'aiculessul22' "<command>"
```

**After `git pull` on the Pi**, restart the app:
```bash
~/uptime-monitor-app/deploy.sh
```

**Service:** managed by systemd as `uptime-monitor.service` (auto-starts on boot)

**Node path:** `/home/emilanca/.nvm/versions/node/v25.8.1/bin/node`
(system node v20 crashes with illegal instruction on this Pi's ARM64)

## Workflow
1. Make changes locally → commit → `git push`
2. SSH into Pi → `git pull` → `./deploy.sh`
