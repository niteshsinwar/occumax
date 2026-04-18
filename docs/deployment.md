# Deployment Guide

## How it works

Every push to `Dev` or `main` triggers a GitHub Actions workflow that:
1. Builds React frontend (Vite, with the correct `VITE_API_URL` baked in)
2. SSHs into the target Oracle Cloud instance
3. Creates/updates `/opt/occumax` as a git repo tracking the branch
4. Writes `/opt/occumax/.env` from `backend/.env.server` + GitHub Secrets
5. Recreates Python venv if missing, installs deps
6. Restarts `occumax-backend` (systemd) → `create_tables()` runs on startup
7. Rsyncs the built frontend to `/opt/occumax/frontend/dist/`
8. Reloads Nginx
9. Health checks `/health` endpoint and the public URL

## Trigger a deploy

```bash
# Deploy to Dev
git push origin Dev

# Deploy to Production (after merging Dev → main)
git push origin main

# Re-run a failed action without a new commit
gh run rerun <run-id> --repo niteshsinwar/occumax

# Watch a running action
gh run watch <run-id> --repo niteshsinwar/occumax

# List recent runs
gh run list --repo niteshsinwar/occumax --limit 5
```

## Checking deploy status

```bash
# GitHub Actions
gh run list --repo niteshsinwar/occumax --limit 5

# Check backend on dev server directly
ssh -i ~/.ssh/occumax_deploy ubuntu@161.118.164.30 \
  "sudo systemctl status occumax-backend --no-pager"

# Tail backend logs
ssh -i ~/.ssh/occumax_deploy ubuntu@161.118.164.30 \
  "sudo journalctl -u occumax-backend -f"

# Test health endpoint
curl http://161.118.164.30/api/health
curl http://80.225.202.88/api/health
```

## Debugging a failed deploy

### 1. Get the error from GitHub Actions
```bash
gh run view <run-id> --repo niteshsinwar/occumax --log-failed
```

### 2. SSH in and check backend logs
```bash
ssh -i ~/.ssh/occumax_deploy ubuntu@161.118.164.30
sudo journalctl -u occumax-backend -n 50 --no-pager
sudo systemctl status occumax-backend
```

### 3. Common failure causes and fixes

| Symptom | Cause | Fix |
|---|---|---|
| `Permission denied` on `/opt/occumax` | `/opt` owned by root | `sudo mkdir -p /opt/occumax && sudo chown ubuntu:ubuntu /opt/occumax` |
| `/opt/occumax/venv/bin/pip not found` | venv was deleted | `python3 -m venv /opt/occumax/venv` |
| `curl: connection refused` on port 8000 | Backend still starting | Wait 10s and retry — startup takes ~7s |
| Frontend loads but API calls fail | CORS or wrong `VITE_API_URL` | Check `/opt/occumax/.env` CORS_ORIGINS and rebuild frontend |
| Port 80 unreachable externally | iptables blocking | `sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT && sudo netfilter-persistent save` |
| `TooManyRequests` from OCI CLI | Rate limited | Wait 30s and retry |
| `LimitExceeded` for E2.1.Micro | Both free slots used | Check existing instances; use paid shape if needed |

## Updating GitHub Secrets

Secrets can't be set via `gh secret set` without the `read:org` scope. Use this script instead:

```python
# pip install PyNaCl
import base64, json, urllib.request
from nacl import encoding, public

TOKEN = "<GH_TOKEN from GitHub Secrets>"  # token needs repo scope
REPO = "niteshsinwar/occumax"
HEADERS = {"Authorization": f"token {TOKEN}", "Content-Type": "application/json"}

req = urllib.request.Request(
    f"https://api.github.com/repos/{REPO}/actions/secrets/public-key", headers=HEADERS)
key_data = json.loads(urllib.request.urlopen(req).read())
key_id = key_data["key_id"]
pub_key = public.PublicKey(key_data["key"].encode(), encoding.Base64Encoder())

def set_secret(name, value):
    sealed = public.SealedBox(pub_key).encrypt(value.encode())
    encrypted = base64.b64encode(sealed).decode()
    payload = json.dumps({"encrypted_value": encrypted, "key_id": key_id}).encode()
    req = urllib.request.Request(
        f"https://api.github.com/repos/{REPO}/actions/secrets/{name}",
        data=payload, headers=HEADERS, method="PUT")
    urllib.request.urlopen(req)
    print(f"✓ {name}")

set_secret("SECRET_NAME", "secret_value")
```

## Current GitHub Secrets

| Secret | Used in | Purpose |
|---|---|---|
| `SSH_PRIVATE_KEY` | Both workflows | SSH into Oracle instances |
| `DEV_HOST` | deploy-dev.yml | Dev server IP (`161.118.164.30`) |
| `MAIN_HOST` | deploy-main.yml | Prod server IP (`80.225.202.88`) |
| `DEV_DATABASE_URL` | deploy-dev.yml | PostgreSQL URL for dev |
| `MAIN_DATABASE_URL` | deploy-main.yml | PostgreSQL URL for prod |
| `GEMINI_API_KEY` | Both workflows | Google Gemini AI key |
| `GH_TOKEN` | Both workflows | GitHub token for server-side git pull |

## Server setup from scratch

If an instance is replaced, run this to set it up:

```bash
# 1. Install packages
sudo apt-get update -q
sudo apt-get install -y nginx python3 python3-pip python3-venv git iptables-persistent

# 2. Open ports
sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save

# 3. Create app dir
sudo mkdir -p /opt/occumax
sudo chown ubuntu:ubuntu /opt/occumax

# 4. Setup Nginx (see .github/workflows/deploy-dev.yml for the nginx config block)

# 5. Setup systemd service (see .github/workflows/deploy-dev.yml for the service block)

# 6. Allow passwordless sudo for service management
echo 'ubuntu ALL=(ALL) NOPASSWD: /bin/systemctl restart occumax-backend, /bin/systemctl reload nginx, /bin/systemctl is-active occumax-backend, /bin/mkdir, /bin/chown' \
  | sudo tee /etc/sudoers.d/occumax

# 7. Push a commit to trigger the GitHub Action — it handles the rest
```
