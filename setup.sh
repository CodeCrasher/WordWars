set -e

PROJECT_NAME="diy-wordle-multiplayer"
REPO_NAME="diyWordle"
REPO_SSH="git@github.com:CodeCrasher/diyWordle.git"
REPO_HTTPS="https://github.com/CodeCrasher/diyWordle"
COMMIT_MESSAGE="Deploy setup updates"

check_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required tool: $1"
    echo "Install: $2"
    exit 1
  fi
}

print_step() {
  echo ""
  echo "==> $1"
}

check_tool git "https://git-scm.com"
check_tool node "https://nodejs.org"
check_tool npm "https://nodejs.org"
check_tool gh "https://cli.github.com"
check_tool railway "npm install -g @railway/cli"

print_step "Installing Node dependencies"
npm install

print_step "Preparing Git repository"
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git init
fi

if git remote get-url origin >/dev/null 2>&1; then
  CURRENT_REMOTE=$(git remote get-url origin)
  if [ "$CURRENT_REMOTE" != "$REPO_SSH" ]; then
    echo "Updating origin remote from $CURRENT_REMOTE to $REPO_SSH"
    git remote set-url origin "$REPO_SSH"
  fi
else
  git remote add origin "$REPO_SSH"
fi

if gh auth status >/dev/null 2>&1; then
  echo "GitHub CLI is already authenticated"
else
  echo "GitHub CLI is not authenticated. Opening login flow..."
  gh auth login
fi

if gh repo view CodeCrasher/"$REPO_NAME" >/dev/null 2>&1; then
  echo "GitHub repo already exists: $REPO_HTTPS"
else
  echo "Creating GitHub repo: CodeCrasher/$REPO_NAME"
  gh repo create CodeCrasher/"$REPO_NAME" --public --source=. --remote=origin
fi

git add .
if git diff --cached --quiet; then
  echo "No local changes to commit"
else
  git commit -m "$COMMIT_MESSAGE"
fi

CURRENT_BRANCH=$(git branch --show-current)
if [ -z "$CURRENT_BRANCH" ]; then
  CURRENT_BRANCH="main"
  git checkout -b "$CURRENT_BRANCH"
fi

git push -u origin "$CURRENT_BRANCH"

print_step "Preparing Railway"
if railway whoami >/dev/null 2>&1; then
  echo "Railway CLI is already authenticated"
else
  echo "Railway CLI is not authenticated. Opening login flow..."
  railway login
fi

if railway status >/dev/null 2>&1; then
  echo "Railway project is already linked"
else
  echo "Creating or linking Railway project: $PROJECT_NAME"
  railway init --name "$PROJECT_NAME"
fi

print_step "Setting Railway environment variables"
railway variables set NODE_ENV=production
railway variables set ALLOWED_ORIGIN="*"

print_step "Triggering Railway deploy"
railway up --detach

echo "Waiting for deploy..."
sleep 60
LIVE_URL=$(railway domain)
GITHUB_USER=$(gh api user -q .login)

echo "================================================"
echo "✅ DIY Wordle is live!"
echo "🎮 URL: $LIVE_URL"
echo "🐙 Repo: https://github.com/$GITHUB_USER/$REPO_NAME"
echo "🔄 CI/CD: push to main = auto-deploy in ~2 min"
echo "📋 Logs: railway logs"
echo "================================================"
