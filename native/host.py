#!/usr/bin/env python3
"""Save one Markdown snapshot and ask macOS to open it via native messaging."""

import json
import os
from pathlib import Path
import re
import struct
import subprocess
import sys

HOST_NAME = "com.tabsorter.editor"
MAX_MESSAGE_BYTES = 8 * 1024 * 1024
MAX_FILENAME_BYTES = 180
FILENAME_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9 ._()\-]*\.md\Z")


def read_exact(stream, length):
    chunks = bytearray()
    while len(chunks) < length:
        chunk = stream.read(length - len(chunks))
        if not chunk:
            raise ValueError("The export message was incomplete.")
        chunks.extend(chunk)
    return bytes(chunks)


def read_message(stream):
    length = struct.unpack("=I", read_exact(stream, 4))[0]
    if length == 0 or length > MAX_MESSAGE_BYTES:
        raise ValueError("The export message must be between 1 byte and 8 MiB.")
    try:
        return json.loads(read_exact(stream, length).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as error:
        raise ValueError("The export message is not valid UTF-8 JSON.") from error


def write_message(stream, message):
    payload = json.dumps(message, ensure_ascii=True).encode("utf-8")
    stream.write(struct.pack("=I", len(payload)))
    stream.write(payload)
    stream.flush()


def validate_request(request):
    if not isinstance(request, dict) or set(request) != {"action", "filename", "markdown", "editor"}:
        raise ValueError("The export request must contain action, filename, markdown, and editor only.")
    if request["action"] != "export":
        raise ValueError("Only Markdown export is supported.")
    filename = request["filename"]
    if (
        not isinstance(filename, str)
        or len(filename.encode("utf-8")) > MAX_FILENAME_BYTES
        or not FILENAME_PATTERN.fullmatch(filename)
        or ".." in filename
    ):
        raise ValueError("Use a simple .md filename up to 180 bytes, without folders or special characters.")
    if not isinstance(request["markdown"], str):
        raise ValueError("The Markdown content must be text.")
    try:
        content = request["markdown"].encode("utf-8")
    except UnicodeEncodeError as error:
        raise ValueError("The Markdown content contains invalid Unicode.") from error
    if len(content) > MAX_MESSAGE_BYTES:
        raise ValueError("The Markdown snapshot exceeds 8 MiB.")
    if request["editor"] not in ("notepad-aurora", "default"):
        raise ValueError("Choose NotepadAurora or the default Markdown application.")
    return filename, content, request["editor"]


def export_directory():
    return Path.home() / "Documents" / "Tab Sorter Snapshots"


def save_snapshot(filename, content):
    directory = export_directory()
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if directory.is_symlink() or not directory.is_dir():
        raise OSError("The snapshot folder must be a regular directory.")
    if directory.stat().st_uid != os.getuid():
        raise OSError("The snapshot folder must belong to the current user.")
    directory.chmod(0o700)
    for index in range(1, 10001):
        name = filename if index == 1 else f"{filename[:-3]} ({index}).md"
        target = directory / name
        try:
            descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        except FileExistsError:
            continue
        try:
            with os.fdopen(descriptor, "wb") as output:
                output.write(content)
                output.flush()
                os.fsync(output.fileno())
        except BaseException:
            target.unlink(missing_ok=True)
            raise
        return target
    raise OSError("Too many snapshots have the same name; choose another filename.")


def open_editor(path, editor):
    command = ["/usr/bin/open"]
    if editor == "notepad-aurora":
        command.extend(["-a", "/Applications/NotepadAurora.app"])
    command.append(str(path))
    subprocess.run(command, check=True, timeout=20, capture_output=True)


def process_request(request):
    result = {"ok": False, "filename": None, "path": None, "opened": False}
    try:
        filename, content, editor = validate_request(request)
        target = save_snapshot(filename, content)
        result.update(filename=target.name, path=str(target))
    except (ValueError, OSError) as error:
        result["error"] = f"Snapshot was not saved: {error}"
        return result
    try:
        open_editor(target, editor)
    except (OSError, subprocess.SubprocessError):
        result["error"] = "Snapshot saved, but the editor could not be opened. Open the saved file from Finder."
        return result
    result.update(ok=True, opened=True)
    return result


def validate_origin(origin):
    config = json.loads(Path(__file__).with_name("host-config.json").read_text(encoding="utf-8"))
    if not isinstance(config, dict) or config.get("host") != HOST_NAME or not re.fullmatch(r"chrome-extension://[a-p]{32}/", origin):
        raise ValueError("The calling extension is not authorized.")
    if origin != config.get("allowed_origin"):
        raise ValueError("The calling extension is not authorized.")


def main():
    try:
        if len(sys.argv) != 2:
            raise ValueError("This helper must be started by the installed Chrome extension.")
        validate_origin(sys.argv[1])
        result = process_request(read_message(sys.stdin.buffer))
    except (ValueError, OSError) as error:
        result = {"ok": False, "filename": None, "path": None, "opened": False, "error": str(error)}
    write_message(sys.stdout.buffer, result)


if __name__ == "__main__":
    main()
