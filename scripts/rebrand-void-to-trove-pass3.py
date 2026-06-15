#!/usr/bin/env python3
"""Pass 3: fix React scope classes, component names, broken partial replaces."""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TROVE = ROOT / "src/vs/workbench/contrib/trove"

REPLACEMENTS = [
    ("@@void-scope", "@@trove-scope"),
    ("@@void-void-icon", "@@trove-icon"),
    ("@@void-force-child-placeholder-trove-fg-1", "@@trove-force-child-placeholder-trove-fg-1"),
    ("!void-text-trove-", "!trove-text-trove-"),
    ("!void-text-xs", "!trove-text-xs"),
    ("VoidSimpleInputBox", "TroveSimpleInputBox"),
    ("VoidCheckBox", "TroveCheckBox"),
    ("VoidButtonBgDarken", "TroveButtonBgDarken"),
    ("_VoidSelectBox", "_TroveSelectBox"),
    ("VoidDiffEditor", "TroveDiffEditor"),
    ("VoidCheckUpdateRespose", "TroveCheckUpdateResponse"),
    ("performVoidCheck", "performTroveCheck"),
    ("voidCheckUpdate", "troveCheckUpdate"),
    ("@@void-scope styles", "@@trove-scope styles"),
    ("// void icon style", "// trove icon style"),
    ("VoidScrollableElt", "TroveScrollableElt"),
    ("VoidSelectBox", "TroveSelectBox"),
]

def main():
    for path in TROVE.rglob("*"):
        if path.suffix not in {".ts", ".tsx", ".js", ".css"}:
            continue
        if "/out/" in str(path):
            continue
        t = path.read_text(encoding="utf-8")
        u = t
        for a, b in REPLACEMENTS:
            u = u.replace(a, b)
        if u != t:
            path.write_text(u, encoding="utf-8")
            print(path.relative_to(ROOT))

if __name__ == "__main__":
    main()
