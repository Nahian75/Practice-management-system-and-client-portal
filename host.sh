#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
docker info >/dev/null 2>&1 || { echo 'Start Docker, then run this command again.'; exit 1; }
action=${1:-up}
setup() {
  docker run --rm -it --user "$(id -u):$(id -g)" -v "$PWD:/workspace" -w /workspace node:24.16.0-bookworm-slim node scripts/setup-hosting.mjs
}
compose() { docker compose --env-file .env.hosting -f compose.hosting.yaml "$@"; }
case "$action" in
  setup) setup ;;
  up|update)
    if [ ! -f .env.hosting ]; then setup; fi
    compose config --quiet
    compose up -d --build --wait --wait-timeout 1200
    echo 'Stass is running. Open the domain from your hosting settings.'
    echo 'For a new installation, accept the invitation sent to your administrator email.'
    ;;
  status) compose ps ;;
  verify) compose exec api node /app/infra/hosting/check-services.mjs ;;
  logs) compose logs --tail 100 -f ;;
  stop) compose stop ;;
  restart) compose restart ;;
  invite)
    shift
    compose exec api node dist/cli/invite.js "$@"
    ;;
  *) echo 'Usage: sh host.sh [setup|up|update|status|verify|logs|stop|restart|invite ...]'; exit 2 ;;
esac
