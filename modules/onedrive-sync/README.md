# OneDrive Sync Module

Syncs specific OneDrive folders to local disk, used by portfolio-tracker to
pull the latest Portfolio Performance XML file from cloud storage.

## Setup

1. Authorize OneDrive access:
```bash
docker run --rm -v $(pwd)/config:/onedrive/conf \
  driveone/onedrive:latest --synchronize
```
Open the URL shown, authenticate, and copy the response URI back.

2. Configure which folder to sync by creating `config/sync_list`:
```
PortfolioPerformance/
```

3. Run sync:
```bash
docker compose up -d onedrive-sync
```

## Architecture

```
OneDrive Cloud
  └── PortfolioPerformance/portfolio.xml
        │
        ▼ (onedrive client syncs periodically)
  /data/onedrive/PortfolioPerformance/portfolio.xml
        │
        ▼ (portfolio-tracker reads on startup)
  Portfolio Performance Java CLI
```
