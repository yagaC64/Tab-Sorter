#!/usr/bin/env python3
"""Install or remove the optional macOS editor helper for this Chrome extension."""

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import sys
import tempfile

HOST_NAME = "com.tabsorter.editor"
ROOT = Path(__file__).resolve().parent.parent


def extension_id_from_manifest():
    for path in (ROOT / "extension" / "manifest.json", ROOT / "manifest.json"):
        if not path.is_file():
            continue
        key = json.loads(path.read_text(encoding="utf-8")).get("key")
        if key:
            digest = hashlib.sha256(base64.b64decode(key, validate=True)).hexdigest()[:32]
            return "".join(chr(ord("a") + int(character, 16)) for character in digest)
    raise ValueError("Pass --extension-id using the ID shown at chrome://extensions.")


def private_write(path, data, mode):
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(data)
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def config_matches(path):
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
        return isinstance(config, dict) and config.get("host") == HOST_NAME
    except (OSError, ValueError):
        return False


def run(arguments=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--extension-id", help="32-letter Chrome extension ID; otherwise derived from manifest key")
    parser.add_argument("--browser-dir", type=Path, help="Chrome user-data directory; normally leave unset")
    parser.add_argument("--uninstall", action="store_true", help="Remove this helper registration and code; preserve snapshots")
    args = parser.parse_args(arguments)
    if platform.system() != "Darwin":
        raise ValueError("This optional editor helper supports macOS only.")
    install_dir = Path.home() / "Library" / "Application Support" / "Tab Sorter"
    browser_dir = args.browser_dir or Path.home() / "Library" / "Application Support" / "Google" / "Chrome"
    registry_dir = browser_dir.expanduser().resolve() / "NativeMessagingHosts"
    registry_path = registry_dir / f"{HOST_NAME}.json"
    config_path = install_dir / "host-config.json"
    host_path = install_dir / "host.py"

    if install_dir.is_symlink() or registry_path.is_symlink():
        raise ValueError("Refusing to replace a symbolic link at the helper installation path.")
    if registry_path.exists():
        existing = json.loads(registry_path.read_text(encoding="utf-8"))
        if not isinstance(existing, dict) or existing.get("name") != HOST_NAME or existing.get("path") != str(host_path):
            raise ValueError("An unrelated native helper occupies this registration; it was left unchanged.")
    if install_dir.exists() and any(install_dir.iterdir()) and not config_matches(config_path):
        raise ValueError("The helper folder contains unrecognized files; it was left unchanged.")

    if args.uninstall:
        registry_path.unlink(missing_ok=True)
        if config_matches(config_path):
            host_path.unlink(missing_ok=True)
            config_path.unlink(missing_ok=True)
            try:
                install_dir.rmdir()
            except OSError:
                pass
        print("Editor helper removed. Existing Markdown snapshots were preserved.")
        return

    extension_id = args.extension_id or extension_id_from_manifest()
    if not re.fullmatch(r"[a-p]{32}", extension_id):
        raise ValueError("The extension ID must be the 32 letters shown at chrome://extensions.")
    interpreter = Path(sys.executable).absolute()
    if any(character.isspace() for character in str(interpreter)) or not os.access(interpreter, os.X_OK):
        raise ValueError("Run this installer using an executable Python 3 interpreter whose path has no spaces.")
    origin = f"chrome-extension://{extension_id}/"
    source = (ROOT / "native" / "host.py").read_text(encoding="utf-8")
    source = f"#!{interpreter}\n" + source.split("\n", 1)[1]
    install_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    install_dir.chmod(0o700)
    registry_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    config = {"host": HOST_NAME, "allowed_origin": origin}
    manifest = {"name": HOST_NAME, "description": "Save Tab Sorter Markdown snapshots and open the chosen editor", "path": str(host_path), "type": "stdio", "allowed_origins": [origin]}
    private_write(host_path, source.encode("utf-8"), 0o700)
    private_write(config_path, (json.dumps(config, indent=2) + "\n").encode("utf-8"), 0o600)
    private_write(registry_path, (json.dumps(manifest, indent=2) + "\n").encode("utf-8"), 0o600)
    print(f"Editor helper installed for extension {extension_id}.")
    print(f"Registration: {registry_path}")
    print(f"Snapshots: {Path.home() / 'Documents' / 'Tab Sorter Snapshots'}")
    print("Reload the extension in Chrome, then choose Export to editor.")


if __name__ == "__main__":
    try:
        run()
    except (ValueError, OSError) as error:
        print(f"Editor helper setup failed: {error}", file=sys.stderr)
        sys.exit(1)
