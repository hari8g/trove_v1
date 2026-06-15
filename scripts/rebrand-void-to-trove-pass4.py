#!/usr/bin/env python3
"""Pass 4: class names, CSS classes, decorator tokens."""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TROVE = ROOT / "src/vs/workbench/contrib/trove"

REPLACEMENTS = [
    ("VoidStatefulModelInfo", "TroveStatefulModelInfo"),
    ("VoidProviderSettings", "TroveProviderSettings"),
    ("VoidUpdateService", "TroveUpdateService"),
    ("VoidUpdateWorkbenchContribution", "TroveUpdateWorkbenchContribution"),
    ("VoidSettingsInput", "TroveSettingsInput"),
    ("VoidSettingsPane", "TroveSettingsPane"),
    ("VoidSettingsEditor", "TroveSettingsEditor"),
    ("'VoidUpdateService'", "'TroveUpdateService'"),
    ("void-sweepIdxBG", "trove-sweepIdxBG"),
    ("void-sweepBG", "trove-sweepBG"),
    ("void-highlightBG", "trove-highlightBG"),
    ("void-greenBG", "trove-greenBG"),
    ("void-redBG", "trove-redBG"),
    ("void-openfolder-button", "trove-openfolder-button"),
    ("void-openssh-button", "trove-openssh-button"),
    ("void-settings-watermark-button", "trove-settings-watermark-button"),
    ("void-link", "trove-link"),
    ("--vscode-void-", "--vscode-trove-"),
    ("void-opacity-60", "trove-opacity-60"),
    ("startupVoidSidebar", "startupTroveSidebar"),
    ("voidViewIcon", "troveViewIcon"),
    ("voidThemeIcon", "troveThemeIcon"),
    ("_getVoidRulesFileContents", "_getTroveRulesFileContents"),
    ("voidFileService", "troveFileService"),
    ("IVoidFileService", "ITroveFileService"),
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
