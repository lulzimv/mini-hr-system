# Mini HR Leave Management System

Lightweight open-source Leave Management System designed for small teams (5-20 employees).

This project demonstrates real-world DevOps and System Administration practices including containerization, reverse proxy configuration, backup automation, and role-based access control.

---

## 🚀 Features

- Employee leave request management
- Automatic leave days calculation (start / end date)
- Leave balance tracking
- Admin approval / rejection workflow
- Role-based authentication (Admin / Employee)
- Calendar view for approved leaves
- CSV export reporting
- SQLite lightweight database
- Automated database backup script
- Dockerized deployment
- Nginx reverse proxy ready configuration

---

## 🏗 Architecture

User Browser  
↓  
Nginx Reverse Proxy  
↓  
Docker Container (Node.js Express App)  
↓  
SQLite Database (local persistent storage)

---

## ⚙️ Installation

### 1️⃣ Clone repository

```bash
git clone https://github.com/lulzimv/mini-hr-system.git
cd mini-hr-system

2️⃣ Start application
docker compose up -d

3️⃣ Access Web UI

http://SERVER-IP:5050/login.html

🔐 Default Login
admin / admin123

💾 Backup
/opt/mini-hr/backup-db.sh

Backup files stored in:
/opt/mini-hr/backups/

Cron example (daily backup at 02:00):
0 2 * * * /opt/mini-hr/backup-db.sh
