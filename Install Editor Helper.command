#!/bin/zsh
set -eu
TASK_DIR="${0:A:h}"
if command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN="$(command -v python3)"
elif [[ -x /opt/homebrew/bin/python3 ]]; then
  PYTHON_BIN=/opt/homebrew/bin/python3
elif [[ -x /usr/local/bin/python3 ]]; then
  PYTHON_BIN=/usr/local/bin/python3
else
  print "Python 3 is required to install the optional editor helper."
  read -r "?Press Return to close."
  exit 1
fi
if "$PYTHON_BIN" "$TASK_DIR/native/install.py" "$@"; then
  SETUP_EXIT=0
  print ""
  print "Setup completed. Your browser tabs were not changed."
else
  SETUP_EXIT=$?
  print ""
  print "Setup did not complete. Review the error above."
fi
read -r "?Press Return to close."
exit "$SETUP_EXIT"
