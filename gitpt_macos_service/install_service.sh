#!/bin/bash

LABEL="com.gitpt.service"
PLIST_NAME="$LABEL.plist"

SCRIPT_DIR=$(cd -P -- "$(dirname -- "$0")" && pwd -P)
PLIST_SRC_PATH="$SCRIPT_DIR/$PLIST_NAME"
PLIST_DST_PATH="$HOME/Library/LaunchAgents/$PLIST_NAME"
PLIST_OUT_PATH="/tmp/$LABEL.out.log"
PLIST_ERR_PATH="/tmp/$LABEL.err.log"

RUN_SERVICE_PATH="$SCRIPT_DIR/run_service.sh"

# import to get API_PATH
source "$SCRIPT_DIR/env.sh"
echo "API path: $API_PATH"

if [ ! -f "$API_PATH" ]; then
    echo "GitPT executable not found"
    exit 1
fi

echo "Patching plist with plutil"

PATCHED_PLIST_NAME="$LABEL.patched.plist"
PATCHED_PLIST_PATH="$SCRIPT_DIR/$PATCHED_PLIST_NAME"

cp -f "$PLIST_SRC_PATH" "$PATCHED_PLIST_PATH"

plutil -replace ProgramArguments -json "[\"/bin/bash\", \"$RUN_SERVICE_PATH\"]" "$PATCHED_PLIST_PATH"
plutil -replace StandardOutPath -string "$PLIST_OUT_PATH" "$PATCHED_PLIST_PATH"
plutil -replace StandardErrorPath -string "$PLIST_ERR_PATH" "$PATCHED_PLIST_PATH"

echo "Validating plist with plutil"
plutil "$PATCHED_PLIST_PATH"

echo "Excluding from quarantine service directory"
xattr -d -r com.apple.quarantine "$SCRIPT_DIR"

echo "Stopping & Booting out"

launchctl kickstart -k gui/$(id -u)/$LABEL 2>/dev/null
launchctl bootout gui/$(id -u) "$PLIST_DST_PATH" 2>/dev/null

echo "Copying/rewriting plist from $PATCHED_PLIST_PATH to $PLIST_DST_PATH"

cp -f "$PATCHED_PLIST_PATH" "$PLIST_DST_PATH"
rm "$PATCHED_PLIST_PATH"

echo "Launching"

chmod +x "$RUN_SERVICE_PATH" 

launchctl bootstrap gui/$(id -u) "$PLIST_DST_PATH"

echo "Check if service is running"

launchctl print gui/$(id -u)/$LABEL >/dev/null Co2>&1 && echo "Status: RUNNING" || echo "Status: NOT RUNNING"

URL="http://localhost:4242/health"
echo "Check at $URL, it should return status 'ok'"

echo "For possible issues see also log files:"
echo "$PLIST_OUT_PATH"
echo "$PLIST_ERR_PATH"

