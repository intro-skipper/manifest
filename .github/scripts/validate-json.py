import json
import pathlib

def main() -> int:
    root = pathlib.Path(".")
    files = sorted(root.rglob("*.json"))

    if not files:
        print("No JSON files found.")
        return 0

    errors: list[tuple[pathlib.Path, Exception]] = []
    for file in files:
        try:
            with file.open("r", encoding="utf-8") as f:
                json.load(f)
            print(f"OK: {file}")
        except Exception as e:  # noqa: BLE001
            errors.append((file, e))

    if errors:
        print("\nInvalid JSON detected:")
        for file, err in errors:
            print(f"- {file}: {err}")
        return 1

    print(f"\nValidated {len(files)} JSON file(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
