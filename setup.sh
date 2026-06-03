set -e

check_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required tool: $1"
    echo "Install: $2"
    exit 1
  fi
}

check_tool git "https://git-scm.com"
check_tool node "https://nodejs.org"
check_tool npm "https://nodejs.org"
check_tool gh "https://cli.github.com"
check_tool railway "npm install -g @railway/cli"

npm install

git init
git add .
git commit -m "Initial commit — DIY Wordle multiplayer"

gh repo create diyWordle --public --source=. --remote=origin --push

railway login

railway init --name diy-wordle-multiplayer

railway variables set NODE_ENV=production
railway variables set ALLOWED_ORIGIN="*"

railway up --detach

echo "Waiting for deploy..."
sleep 60
LIVE_URL=$(railway domain)

echo "================================================"
echo "✅ DIY Wordle is live!"
echo "🎮 URL: $LIVE_URL"
echo "🐙 Repo: https://github.com/$(gh api user -q .login)/diyWordle"
echo "🔄 CI/CD: push to main = auto-deploy in ~2 min"
echo "📋 Logs: railway logs"
echo "================================================"
