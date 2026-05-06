"""Validate JSON files and Jellyfin plugin manifests.

Every ``*.json`` file under the repository root is parsed for syntax. Files
named ``manifest.json`` are additionally validated against the shape
Jellyfin 10.11's ``InstallationManager`` expects when deserialising and
using ``PackageInfo`` / ``VersionInfo`` (see
``Emby.Server.Implementations/Updates/InstallationManager.cs`` on the
``release-10.11.z`` branch):

* the top-level value is a list of package objects;
* each package supplies the required ``PackageInfo`` properties and any
  ``imageUrl`` is an absolute http(s) URL;
* every ``versions[].version`` parses as a ``System.Version`` (2-4
  dot-separated non-negative integers);
* ``targetAbi`` is null/empty or also parses as ``System.Version`` so the
  later ``Version.Parse(ver.TargetAbi)`` in the compatibility filter does
  not throw;
* ``sourceUrl`` is an absolute http(s) URL whose path extension is
  ``.zip`` (case-insensitive), matching ``Path.GetExtension`` against the
  URL path;
* ``checksum`` is a 32-character hexadecimal MD5.

Other ``*.json`` files are only required to be valid JSON.
"""

from __future__ import annotations

import json
import pathlib
import posixpath
import re
import uuid
from typing import Any
from urllib.parse import urlparse


# ``System.Version`` accepts 2-4 dot-separated non-negative Int32 components
# and no prerelease/suffix/text.
_VERSION_RE = re.compile(r"^\d+\.\d+(?:\.\d+){0,2}$")
_MAX_VERSION_COMPONENT = 2_147_483_647
# 32-character hexadecimal MD5, case-insensitive.
_CHECKSUM_RE = re.compile(r"^[0-9a-fA-F]{32}$")

_REQUIRED_PACKAGE_FIELDS = (
    "guid",
    "name",
    "overview",
    "description",
    "owner",
    "category",
    "versions",
)
_PACKAGE_STRING_FIELDS = ("name", "overview", "description", "owner", "category")
_REQUIRED_VERSION_FIELDS = (
    "version",
    "changelog",
    "targetAbi",
    "sourceUrl",
    "checksum",
    "timestamp",
)


def _is_system_version(value: str) -> bool:
    if not _VERSION_RE.match(value):
        return False
    return all(
        int(component) <= _MAX_VERSION_COMPONENT for component in value.split(".")
    )


def _is_guid(value: str) -> bool:
    if not isinstance(value, str) or not value:
        return False
    try:
        uuid.UUID(value)
    except (ValueError, AttributeError, TypeError):
        return False
    return True


def _try_urlparse(value: str):
    try:
        return urlparse(value)
    except ValueError:
        return None


def _is_absolute_http_url(value: Any) -> bool:
    if not isinstance(value, str) or not value:
        return False
    parsed = _try_urlparse(value)
    if parsed is None:
        return False
    return parsed.scheme.lower() in ("http", "https") and bool(parsed.netloc)


def _url_path_extension(value: str) -> str:
    parsed = _try_urlparse(value)
    if parsed is None:
        return ""
    return posixpath.splitext(parsed.path)[1]


def _validate_version(
    version: Any, base_path: str, errors: list[str]
) -> None:
    if not isinstance(version, dict):
        errors.append(f"{base_path}: must be a JSON object")
        return

    for field in _REQUIRED_VERSION_FIELDS:
        if field not in version:
            errors.append(f"{base_path}.{field}: required field is missing")

    if "version" in version:
        v = version["version"]
        if not isinstance(v, str):
            errors.append(f"{base_path}.version: must be a string")
        elif not _is_system_version(v):
            errors.append(
                f"{base_path}.version: '{v}' is not a valid System.Version "
                "(expected 2-4 dot-separated non-negative Int32 components)"
            )

    if "targetAbi" in version:
        ta = version["targetAbi"]
        if ta is None or ta == "":
            pass  # nullable / empty is allowed by InstallationManager
        elif not isinstance(ta, str):
            errors.append(
                f"{base_path}.targetAbi: must be a string, null, or empty"
            )
        elif not _is_system_version(ta):
            errors.append(
                f"{base_path}.targetAbi: '{ta}' is not a valid System.Version "
                "(expected 2-4 dot-separated non-negative Int32 components)"
            )

    if "sourceUrl" in version:
        su = version["sourceUrl"]
        if not isinstance(su, str) or not su:
            errors.append(f"{base_path}.sourceUrl: must be a non-empty string")
        elif not _is_absolute_http_url(su):
            errors.append(
                f"{base_path}.sourceUrl: must be an absolute http(s) URL"
            )
        elif _url_path_extension(su).lower() != ".zip":
            errors.append(
                f"{base_path}.sourceUrl: sourceUrl must point to a .zip file"
            )

    if "checksum" in version:
        cs = version["checksum"]
        if not isinstance(cs, str):
            errors.append(f"{base_path}.checksum: must be a string")
        elif not _CHECKSUM_RE.match(cs):
            errors.append(
                f"{base_path}.checksum: must be a 32-character hexadecimal MD5"
            )

    if "changelog" in version:
        cl = version["changelog"]
        if cl is not None and not isinstance(cl, str):
            errors.append(
                f"{base_path}.changelog: must be a string when present"
            )

    if "timestamp" in version:
        ts = version["timestamp"]
        if ts is not None and not isinstance(ts, str):
            errors.append(
                f"{base_path}.timestamp: must be a string when present"
            )


def _validate_package(
    package: Any, base_path: str, errors: list[str]
) -> None:
    if not isinstance(package, dict):
        errors.append(f"{base_path}: must be a JSON object")
        return

    for field in _REQUIRED_PACKAGE_FIELDS:
        if field not in package:
            errors.append(f"{base_path}.{field}: required field is missing")

    if "guid" in package:
        g = package["guid"]
        if not isinstance(g, str):
            errors.append(f"{base_path}.guid: must be a string")
        elif not _is_guid(g):
            errors.append(f"{base_path}.guid: '{g}' is not a valid GUID")

    for field in _PACKAGE_STRING_FIELDS:
        if field in package and not isinstance(package[field], str):
            errors.append(f"{base_path}.{field}: must be a string")

    if "imageUrl" in package:
        iu = package["imageUrl"]
        if iu is not None:
            if not isinstance(iu, str):
                errors.append(
                    f"{base_path}.imageUrl: must be a string when present"
                )
            elif not _is_absolute_http_url(iu):
                errors.append(
                    f"{base_path}.imageUrl: must be an absolute http(s) URL"
                )

    if "versions" in package:
        versions = package["versions"]
        if not isinstance(versions, list):
            errors.append(f"{base_path}.versions: must be a list")
        else:
            for index, ver in enumerate(versions):
                _validate_version(ver, f"{base_path}.versions[{index}]", errors)


def _validate_manifest(data: Any, errors: list[str]) -> None:
    if not isinstance(data, list):
        errors.append("$: manifest top-level value must be a JSON array")
        return
    for index, package in enumerate(data):
        _validate_package(package, f"$[{index}]", errors)


def _is_manifest_file(path: pathlib.Path) -> bool:
    return path.name == "manifest.json"


def main() -> int:
    root = pathlib.Path(".")
    files = sorted(root.rglob("*.json"))

    if not files:
        print("No JSON files found.")
        return 0

    file_errors: list[tuple[pathlib.Path, list[str]]] = []
    for file in files:
        errors: list[str] = []
        try:
            with file.open("r", encoding="utf-8") as f:
                data = json.load(f)
        except json.JSONDecodeError as e:
            errors.append(
                f"$: invalid JSON: {e.msg} (line {e.lineno} column {e.colno})"
            )
            file_errors.append((file, errors))
            continue
        except OSError as e:
            errors.append(f"$: failed to read file: {e}")
            file_errors.append((file, errors))
            continue

        if _is_manifest_file(file):
            _validate_manifest(data, errors)

        if errors:
            file_errors.append((file, errors))
        else:
            print(f"OK: {file}")

    if file_errors:
        print("\nValidation errors:")
        for file, errs in file_errors:
            for err in errs:
                print(f"- {file}: {err}")
        return 1

    print(f"\nValidated {len(files)} JSON file(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
