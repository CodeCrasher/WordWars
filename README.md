# WordWars

Competitive multiplayer Wordle — the host sets the word and category,
players race to solve it. Scoring is based on speed and guess
efficiency. Built with Node.js, Express, and Socket.io.

## Prerequisites
- Node.js 20+
- Git
- GitHub CLI — https://cli.github.com
- Railway CLI — npm install -g @railway/cli
- Railway account — https://railway.app

## One-Time Setup
  chmod +x setup.sh
  ./setup.sh

## How CI/CD Works
  Push to main
    → GitHub Actions: syntax check + health check (~30s)
    → Railway: Nixpacks build + deploy (~2 min)
    → Zero-downtime rollover via healthcheck
  Total: ~2-3 minutes from git push to live

## Local Development
  npm install
  node server.js
  # Open http://localhost:3000
  # Admin PIN default: 1234

## Environment Variables
  PORT           → Injected by Railway automatically. Do not set.
  ADMIN_PIN      → Default: 1234. Override for production.
  ALLOWED_ORIGIN → Default: *. Set to your Railway domain in production.

## Useful Commands
  railway logs      # tail live logs
  railway domain    # get your public URL
  railway rollback  # revert to previous deploy

## Estimated Cost
  ~$5-10/month on Railway Hobby plan
