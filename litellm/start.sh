#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
VENV="$ROOT/.venv"
ENV_FILE="$ROOT/.env"

if [[ ! -d "$VENV" ]]; then
  echo "Virtual env not found. Run from this directory:"
  echo "  uv venv --python 3.12 .venv"
  echo "  uv pip install --python .venv/bin/python -r requirements.txt"
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE — copy .env.example and add AWS credentials."
  exit 1
fi

# LiteLLM has no --env-file flag; export vars for os.environ/ references in config
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

# Normalize region env vars (LiteLLM + boto3)
export AWS_REGION="${AWS_REGION:-${AWS_REGION_NAME:-${AWS_DEFAULT_REGION:-us-east-1}}}"
export AWS_REGION_NAME="${AWS_REGION_NAME:-$AWS_REGION}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-$AWS_REGION}"

# Profile mode: use ~/.aws/credentials for the named profile
if [[ -n "${AWS_PROFILE:-}" ]]; then
  unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
fi

verify_aws_credentials() {
  if ! command -v aws &>/dev/null; then
    echo "WARNING: aws CLI not found — skipping credential preflight."
    return 0
  fi

  if [[ -n "${AWS_ACCESS_KEY_ID:-}" && "${AWS_ACCESS_KEY_ID}" == ASIA* && -z "${AWS_SESSION_TOKEN:-}" ]]; then
    echo "ERROR: Temporary AWS credentials detected (ASIA* access key) but AWS_SESSION_TOKEN is missing."
    echo ""
    echo "Refresh credentials and update litellm/.env:"
    echo "  aws sso login --profile YOUR_PROFILE"
    echo "  eval \"\$(aws configure export-credentials --profile YOUR_PROFILE --format env)\""
    echo "  # paste AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN into .env"
    exit 1
  fi

  if ! aws sts get-caller-identity &>/dev/null; then
    echo "ERROR: AWS credentials are invalid or expired."
    echo ""
    if [[ -n "${AWS_PROFILE:-}" ]]; then
      echo "Try: aws sso login --profile ${AWS_PROFILE}"
    else
      echo "Try refreshing temporary credentials:"
      echo "  eval \"\$(aws configure export-credentials --profile YOUR_PROFILE --format env)\""
      echo "Or create new IAM keys in AWS Console → IAM → Users → Security credentials."
    fi
    echo ""
    echo "Verify with: aws sts get-caller-identity"
    exit 1
  fi

  echo "AWS identity OK: $(aws sts get-caller-identity --query Account --output text 2>/dev/null) ($(aws sts get-caller-identity --query Arn --output text 2>/dev/null))"
}

verify_aws_credentials

exec "$VENV/bin/litellm" \
  --config "$ROOT/litellm_config.yaml" \
  --port 4000
