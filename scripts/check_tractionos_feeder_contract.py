from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

REQUIRED_FILES = [
    ROOT / "README.md",
    ROOT / "docs" / "control-packet.md",
    ROOT / "docs" / "kpi-spec.md",
    ROOT / "docs" / "tractionos-feeder-contract.md",
]

REQUIRED_PHRASES = {
    "README.md": [
        "read-only presentation",
        "Acumatica = financial, order, inventory, and procurement truth",
        "Pipedrive = sales activity and pipeline truth",
        "no writeback to source systems",
        "No mock data in production",
    ],
    "docs/tractionos-feeder-contract.md": [
        "requirements feeder for `tractionos`",
        "not a separate product to scale independently by default",
        "explicit source system",
        "explicit field or endpoint mapping",
        "refresh cadence",
        "failure behavior",
        "validation or reconciliation method",
        "Leadership flash KPIs",
        "Exception widgets",
        "Do not archive this repo",
    ],
    "docs/control-packet.md": [
        "Acumatica",
        "Pipedrive",
        "read-only",
    ],
    "docs/kpi-spec.md": [
        "source",
        "freshness",
        "certification",
    ],
}


def relative(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def main() -> int:
    issues: list[str] = []

    for path in REQUIRED_FILES:
        if not path.exists():
            issues.append(f"missing feeder contract file: {relative(path)}")

    for relative_path, phrases in REQUIRED_PHRASES.items():
        path = ROOT / relative_path
        if not path.exists():
            continue

        text = path.read_text(encoding="utf-8").lower()
        for phrase in phrases:
            if phrase.lower() not in text:
                issues.append(f"{relative_path}: missing required phrase `{phrase}`")

    if issues:
        print("Scoreboard TractionOS feeder contract check failed:")
        for issue in issues:
            print(f"- {issue}")
        return 1

    print("Scoreboard TractionOS feeder contract check passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

