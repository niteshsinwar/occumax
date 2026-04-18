# Oracle Cloud Infrastructure

All infrastructure is managed via OCI CLI (`oci` command). Never create/delete resources manually via the console — use CLI so actions are reproducible and traceable.

## Account

- **Tenancy ID**: `ocid1.tenancy.oc1..aaaaaaaawrxzqbmt477sqdh3jerxorafiz5n7lfa44najze5radhocyqte4q`
- **Region**: `ap-mumbai-1`
- **OCI CLI config**: `~/.oci/`
- **Compartment**: root tenancy (same as tenancy ID above)

## Compute Instances

| Name | Role | Branch | IP | Shape | OCPU | RAM | Instance ID |
|---|---|---|---|---|---|---|---|
| `occumax-dev` | Dev server | `Dev` | `161.118.164.30` | E2.1.Micro | 1 | 1 GB | `ocid1.instance.oc1.ap-mumbai-1.anrg6ljrfcyztiaclrnbm5qfxjjlinpdvvp6ur6hmza5s5qmrs73nvsntfba` |
| `occumax-main` | Production | `main` | `80.225.202.88` | E2.1.Micro | 1 | 1 GB | `ocid1.instance.oc1.ap-mumbai-1.anrg6ljrfcyztiac3u6bxx3hfvtaqvqtfzfm5ixzn2juselarrdef5dz6nzq` |
| `smart-eye-a1` | Reserved (other project) | — | — | A1.Flex | 4 | 24 GB | `ocid1.instance.oc1.ap-mumbai-1.anrg6ljrfcyztiacsvcn4jpu7jcvlgndvq47bkfk5ekdlpaeme4zhilv7aja` |

## Networking

- **VCN**: `smart-eye-vcn` — `ocid1.vcn.oc1.ap-mumbai-1.amaaaaaafcyztiaaibnmwdi6clgadhzpxmb6634gj67l47cdlinvqinocnwa`
- **Subnet**: `smart-eye-subnet` — `ocid1.subnet.oc1.ap-mumbai-1.aaaaaaaasmlcplxuh52itik72dygt2oqtnlmverevutr5aqczqd4ccn2slda`
- **Security List**: `smart-eye-sl` — `ocid1.securitylist.oc1.ap-mumbai-1.aaaaaaaazhwi2blyhj7hpiznndyq63bccgx63s4q2znxdwjszjdmspfteafa`

### Open Ports (Security List Ingress)
| Port | Protocol | Source | Purpose |
|---|---|---|---|
| 22 | TCP | 0.0.0.0/0 | SSH |
| 80 | TCP | 0.0.0.0/0 | HTTP (Nginx) |
| 443 | TCP | 0.0.0.0/0 | HTTPS |

**Note**: OCI security list is not enough alone — Ubuntu's iptables also needs rules.
Both servers have persistent iptables rules allowing ports 80/443 (saved via `netfilter-persistent`).

## SSH Access

- **Key pair**: `~/.ssh/occumax_deploy` (private) / `~/.ssh/occumax_deploy.pub` (public)
- **Username**: `ubuntu`

```bash
# Dev
ssh -i ~/.ssh/occumax_deploy ubuntu@161.118.164.30

# Production
ssh -i ~/.ssh/occumax_deploy ubuntu@80.225.202.88
```

## Server Layout (both instances)

```
/opt/occumax/
├── .git/                  # git repo (branch: Dev or main)
├── backend/               # FastAPI source
├── frontend/dist/         # Built React SPA (served by Nginx)
├── venv/                  # Python virtualenv
└── .env                   # Generated at deploy time from .env.server + GitHub Secrets
```

**Services on each server:**
- `occumax-backend` (systemd) — uvicorn on `127.0.0.1:8000`
- `nginx` (systemd) — serves port 80, proxies `/api/` → backend

## Common OCI CLI Commands

```bash
# List all running instances
SUPPRESS_LABEL_WARNING=True oci compute instance list \
  --compartment-id ocid1.tenancy.oc1..aaaaaaaawrxzqbmt477sqdh3jerxorafiz5n7lfa44najze5radhocyqte4q \
  --all 2>/dev/null | grep -E '"display-name"|"lifecycle-state"|"shape"'

# Get public IP of an instance
SUPPRESS_LABEL_WARNING=True oci compute vnic-attachment list \
  --compartment-id ocid1.tenancy.oc1..aaaaaaaawrxzqbmt477sqdh3jerxorafiz5n7lfa44najze5radhocyqte4q \
  --instance-id <INSTANCE_ID> 2>/dev/null

# Create a new E2.1.Micro instance
SUPPRESS_LABEL_WARNING=True oci compute instance launch \
  --compartment-id ocid1.tenancy.oc1..aaaaaaaawrxzqbmt477sqdh3jerxorafiz5n7lfa44najze5radhocyqte4q \
  --availability-domain "OIGc:AP-MUMBAI-1-AD-1" \
  --shape "VM.Standard.E2.1.Micro" \
  --image-id "ocid1.image.oc1.ap-mumbai-1.aaaaaaaa3yc7aswdetryjk6knfe5zlex6opdvab5oazebaebst5zri3ocxcq" \
  --subnet-id "ocid1.subnet.oc1.ap-mumbai-1.aaaaaaaasmlcplxuh52itik72dygt2oqtnlmverevutr5aqczqd4ccn2slda" \
  --display-name "<name>" \
  --assign-public-ip true \
  --metadata "{\"ssh_authorized_keys\": \"$(cat ~/.ssh/occumax_deploy.pub)\"}"

# Terminate an instance
SUPPRESS_LABEL_WARNING=True oci compute instance terminate \
  --instance-id <INSTANCE_ID> --force
```

## Known Limits & Gotchas

- **E2.1.Micro**: max 2 free instances. Both slots used by Occumax. Paid instances available on the same account.
- **A1.Flex**: Mumbai capacity is frequently exhausted. If needed, retry or use a different region.
- **iptables**: OCI security list opens the port at network level but Ubuntu's own iptables also blocks by default. Always run `sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT` + `sudo netfilter-persistent save` on new instances.
- **OCI rate limiting**: parallel API calls can trigger 429. Add delays between calls if needed.
- **Image IDs are region-specific**: the Ubuntu 22.04 x86 image for Mumbai is `ocid1.image.oc1.ap-mumbai-1.aaaaaaaa3yc7aswdetryjk6knfe5zlex6opdvab5oazebaebst5zri3ocxcq`
