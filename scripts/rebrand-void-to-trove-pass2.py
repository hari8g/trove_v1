#!/usr/bin/env python3
"""Second pass: remaining void identifiers in trove contrib and UI strings."""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TROVE = ROOT / "src/vs/workbench/contrib/trove"

REPLACEMENTS = [
    ("voidSettingsState", "troveSettingsState"),
    ("voidSettings", "troveSettings"),
    ("VOID_", "TROVE_"),
    ("'void.", "'trove."),
    ('"void.', '"trove.'),
    ("void.autocompleteService", "trove.autocompleteService"),
    ("void.cmdShiftL", "trove.cmdShiftL"),
    ("void.historyAction", "trove.historyAction"),
    ("void.settingsAction", "trove.settingsAction"),
    ("void.updater.", "trove.updater."),
    ("void.voidCheckUpdate", "trove.troveCheckUpdate"),
    ("voidCheckUpdate", "troveCheckUpdate"),
    ("workbench.contrib.void.", "workbench.contrib.trove."),
    ("voidMetricsPollService", "troveMetricsPollService"),
    ("voidGenerateCommitMessageService", "troveGenerateCommitMessageService"),
    ("voidSCMGenerateCommitMessageLoading", "troveSCMGenerateCommitMessageLoading"),
    ("voidChatThreadService", "troveChatThreadService"),
    ("void.copyfileprompt", "trove.copyfileprompt"),
    ("voidCopyPrompt", "troveCopyPrompt"),
    ("void.goToChat", "trove.goToChat"),
    ("void-deleted-blacklist-2", "trove-deleted-blacklist-2"),
    ("void-chats.json", "trove-chats.json"),
    ("void-settings.json", "trove-settings.json"),
    ("void-max-w-", "trove-max-w-"),
    ("void-scope", "trove-scope"),
    ('-p "void-"', '-p "trove-"'),
    ("prefix: 'void-'", "prefix: 'trove-'"),
    ("'void-warning'", "'trove-warning'"),
    ("'void-ring-color'", "'trove-ring-color'"),
    ("'void-link-color'", "'trove-link-color'"),
    ("'void.redBG'", "'trove.redBG'"),
    ("'void.sweepBG'", "'trove.sweepBG'"),
    ("'void.highlightBG'", "'trove.highlightBG'"),
    ("'void.sweepIdxBG'", "'trove.sweepIdxBG'"),
    ("Void's Settings", "Trove's Settings"),
    ("Void\\'s Settings", "Trove\\'s Settings"),
    ("voidSettingsInputsName", "troveSettingsInputsName"),
    ("voidSettingsActionGear", "troveSettingsActionGear"),
    ("voidSettingsAction2", "troveSettingsAction2"),
    ("voidSettings", "troveSettings"),
    ("voidOpenSidebar", "troveOpenSidebar"),
    ("voidCmdL", "troveCmdL"),
    ("voidQuickEditAction", "troveQuickEditAction"),
    ("packaged with Void", "packaged with Trove"),
    ("recognized by Void", "recognized by Trove"),
    ("into Void.", "into Trove."),
    ("Void's settings and chats in and out of Void.", "Trove's settings and chats in and out of Trove."),
    ("How would you like to use Void?", "How would you like to use Trove?"),
    ("restart Void", "restart Trove"),
    ("very old version of Void", "very old version of Trove"),
    ("void-scrollable-element", "trove-scrollable-element"),
    ("// voidSettings", "// troveSettings"),
    (".void-editor", ".trove-editor"),
]

def main():
    changed = 0
    for path in TROVE.rglob("*"):
        if not path.is_file() or path.suffix not in {".ts", ".tsx", ".js", ".css", ".json"}:
            continue
        if "node_modules" in path.parts or "/out/" in str(path):
            continue
        text = path.read_text(encoding="utf-8")
        updated = text
        for old, new in REPLACEMENTS:
            updated = updated.replace(old, new)
        if updated != text:
            path.write_text(updated, encoding="utf-8")
            changed += 1
            print(f"UPDATED: {path.relative_to(ROOT)}")
    print(f"Pass 2 done: {changed} files")

if __name__ == "__main__":
    main()
