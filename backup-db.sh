#!/bin/sh
set -e

mkdir -p /opt/mini-hr/backups
TS=$(date +%F_%H-%M-%S)
cp /opt/mini-hr/app/hr.db /opt/mini-hr/backups/hr_${TS}.db
find /opt/mini-hr/backups -type f -name "hr_*.db" -mtime +14 -delete
echo "Backup created: /opt/mini-hr/backups/hr_${TS}.db"
