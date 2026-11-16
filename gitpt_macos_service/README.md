# Description

MacOS helper to use https://github.com/scouzi1966/maclocal-api as launchctl agent (start on Mac boot)

# Setup

1. Make sure GitPT is installed
2. Copy the whole `gitpt_macos_service` to user home root like `~/gitpt_macos_service` to avoid `launchctl` error regarding "run_service.sh: Operation not permitted"
2. Make `install_service.sh` executable with `chmod +x install_service.sh` and run it. This script will setup and launch service and troubleshoot some launch errors like "Bootstrap failed: 5: Input/output error"
