#!/usr/bin/env python3
"""Rebrand Void -> Trove across the repository (source, frontend, product config)."""

import os
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# Directories/files to process for content replacement
CONTENT_ROOTS = [
    ROOT / "src",
    ROOT / "product.json",
    ROOT / "package.json",
    ROOT / "scripts",
    ROOT / "extensions" / "open-remote-ssh",
    ROOT / "extensions" / "open-remote-wsl",
    ROOT / "build" / "win32",
]

SKIP_DIR_NAMES = {
    "node_modules", ".git", "out", "dist",
}

EXTENSIONS = {
    ".ts", ".tsx", ".js", ".jsx", ".json", ".css", ".html", ".md",
    ".sh", ".iss", ".desktop", ".yml", ".yaml", ".xml", ".plist",
}

# Order matters: longer / more specific patterns first
REPLACEMENTS = [
    ("contrib/void/", "contrib/trove/"),
    ("contrib/void", "contrib/trove"),
    ("void-channel-", "trove-channel-"),
    ("void.settingsServiceStorage", "trove.settingsServiceStorage"),
    ("void.chatThreadStorage", "trove.chatThreadStorage"),
    ("void.app.", "trove.app."),
    ("void.app.machineId", "trove.app.machineId"),
    ("void.app.oldMachineId", "trove.app.oldMachineId"),
    ("void.machineId", "trove.machineId"),
    ("voidVersion", "troveVersion"),
    ("voidRelease", "troveRelease"),
    (".void-editor", ".trove-editor"),
    (".void-server", ".trove-server"),
    (".voidrules", ".troverules"),
    ("void-server", "trove-server"),
    ("void-tunnel", "trove-tunnel"),
    ("void-tunnelservice", "trove-tunnelservice"),
    ("voideditor", "troveeditor"),
    ("com.voideditor", "com.troveeditor"),
    ("void-editor", "trove-editor"),
    ("void-reh-", "trove-reh-"),
    ("void-settings-tsx", "trove-settings-tsx"),
    ("void-onboarding", "trove-onboarding"),
    ("void-editor-widgets-tsx", "trove-editor-widgets-tsx"),
    ("void-tooltip", "trove-tooltip"),
    ("void.contribution", "trove.contribution"),
    ("void.css", "trove.css"),
    ("workbench.view.void", "workbench.view.trove"),
    ("workbench.input.void", "workbench.input.trove"),
    ("workbench.action.toggleVoid", "workbench.action.toggleTrove"),
    ("void.sidebar", "trove.sidebar"),
    ("void.ctrlLAction", "trove.ctrlLAction"),
    ("void.ctrlKAction", "trove.ctrlKAction"),
    ("void.generateCommitMessageAction", "trove.generateCommitMessageAction"),
    ("void.loadingGenerateCommitMessageAction", "trove.loadingGenerateCommitMessageAction"),
    ("voidFailedToGenerateCommitMessage", "troveFailedToGenerateCommitMessage"),
    ("voidCommitMessagePrompt", "troveCommitMessagePrompt"),
    ("voidCommitMessagePromptCancel", "troveCommitMessagePromptCancel"),
    ("voidCommitMessagePromptTooltip", "troveCommitMessagePromptTooltip"),
    ("voidCommitMessagePromptCancelTooltip", "troveCommitMessagePromptCancelTooltip"),
    ("IVoidSettingsService", "ITroveSettingsService"),
    ("IVoidModelService", "ITroveModelService"),
    ("IVoidUpdateService", "ITroveUpdateService"),
    ("IVoidSCMService", "ITroveSCMService"),
    ("IVoidCommandBarService", "ITroveCommandBarService"),
    ("VoidSettingsState", "TroveSettingsState"),
    ("VoidSettingsService", "TroveSettingsService"),
    ("voidSettingsService", "troveSettingsService"),
    ("voidSettingsTypes", "troveSettingsTypes"),
    ("voidSettingsPane", "troveSettingsPane"),
    ("voidModelService", "troveModelService"),
    ("voidUpdateService", "troveUpdateService"),
    ("voidUpdateServiceTypes", "troveUpdateServiceTypes"),
    ("voidUpdateActions", "troveUpdateActions"),
    ("voidUpdateMainService", "troveUpdateMainService"),
    ("voidSCMService", "troveSCMService"),
    ("voidSCMMainService", "troveSCMMainService"),
    ("voidSCMTypes", "troveSCMTypes"),
    ("voidSelectionHelperWidget", "troveSelectionHelperWidget"),
    ("voidCommandBarService", "troveCommandBarService"),
    ("voidOnboardingService", "troveOnboardingService"),
    ("VoidSelectionHelperProps", "TroveSelectionHelperProps"),
    ("VoidSelectionHelperMain", "TroveSelectionHelperMain"),
    ("VoidSelectionHelper", "TroveSelectionHelper"),
    ("VoidCommandBar", "TroveCommandBar"),
    ("VoidTooltip", "TroveTooltip"),
    ("VoidOnboardingContent", "TroveOnboardingContent"),
    ("VoidOnboarding", "TroveOnboarding"),
    ("VoidIcon", "TroveIcon"),
    ("mountVoidOnboarding", "mountTroveOnboarding"),
    ("mountVoidSettings", "mountTroveSettings"),
    ("mountVoidCommandBar", "mountTroveCommandBar"),
    ("mountVoidSelectionHelper", "mountTroveSelectionHelper"),
    ("mountVoidTooltip", "mountTroveTooltip"),
    ("VoidChatArea", "TroveChatArea"),
    ("VoidChatAreaProps", "TroveChatAreaProps"),
    ("VoidInputBox", "TroveInputBox"),
    ("VoidInputBox2", "TroveInputBox2"),
    ("VoidCustomDropdownBox", "TroveCustomDropdownBox"),
    ("VoidSwitch", "TroveSwitch"),
    ("VoidSlider", "TroveSlider"),
    ("VoidError", "TroveError"),
    ("VoidSCM", "TroveSCM"),
    ("VoidMainUpdateService", "TroveMainUpdateService"),
    ("VoidSCMService", "TroveSCMService"),
    ("Void Side Bar", "Trove Side Bar"),
    ("Welcome to Void", "Welcome to Trove"),
    ("Enter the Void", "Enter Trove"),
    ("Void's Settings", "Trove's Settings"),
    ("Void recognizes", "Trove recognizes"),
    ("Void can access", "Trove can access"),
    ("Void Error:", "Trove Error:"),
    ("Void useAccessor", "Trove useAccessor"),
    ("Void: ", "Trove: "),
    ("Void ", "Trove "),
    ("'Void'", "'Trove'"),
    ('"Void"', '"Trove"'),
    ("text-void-", "text-trove-"),
    ("bg-void-", "bg-trove-"),
    ("border-void-", "border-trove-"),
    ("ring-void-", "ring-trove-"),
    ("from-void-", "from-trove-"),
    ("to-void-", "to-trove-"),
    ("--void-", "--trove-"),
    ("void.greenBG", "trove.greenBG"),
    ("void.greenBG", "trove.greenBG"),
    ("void-fg-", "trove-fg-"),
    ("void-bg-", "trove-bg-"),
    ("void-border-", "trove-border-"),
    ("voidWarning", "troveWarning"),
    ("voidUpdate", "troveUpdate"),
    ("voidRules", "troveRules"),
    ("voidRulesURI", "troveRulesURI"),
    ("voidRulesFile", "troveRulesFile"),
    ("applicationName\": \"void\"", "applicationName\": \"trove\""),
    ("urlProtocol\": \"void\"", "urlProtocol\": \"trove\""),
    ("win32DirName\": \"Void\"", "win32DirName\": \"Trove\""),
    ("win32NameVersion\": \"Void\"", "win32NameVersion\": \"Trove\""),
    ("win32RegValueName\": \"VoidEditor\"", "win32RegValueName\": \"TroveEditor\""),
    ("win32AppUserModelId\": \"Void.Editor\"", "win32AppUserModelId\": \"Trove.Editor\""),
    ("win32ShellNameShort\": \"V&oid\"", "win32ShellNameShort\": \"T&rove\""),
    ("linuxIconName\": \"void-editor\"", "linuxIconName\": \"trove-editor\""),
    ("nameShort\": \"Void\"", "nameShort\": \"Trove\""),
    ("nameLong\": \"Void\"", "nameLong\": \"Trove\""),
    ("dataFolderName\": \".void-editor\"", "dataFolderName\": \".trove-editor\""),
    ("serverDataFolderName\": \".void-server\"", "serverDataFolderName\": \".trove-server\""),
    ("serverApplicationName\": \"void-server\"", "serverApplicationName\": \"trove-server\""),
    ("tunnelApplicationName\": \"void-tunnel\"", "tunnelApplicationName\": \"trove-tunnel\""),
    ("win32MutexName\": \"voideditor\"", "win32MutexName\": \"troveeditor\""),
    ("darwinBundleIdentifier\": \"com.voideditor.code\"", "darwinBundleIdentifier\": \"com.troveeditor.code\""),
    ("'X-Title': 'Void'", "'X-Title': 'Trove'"),
    ("KeybindingWeight.VoidExtension", "KeybindingWeight.TroveExtension"),
    ("VoidExtension", "TroveExtension"),
    ("VOID_SETTINGS_STORAGE_KEY", "TROVE_SETTINGS_STORAGE_KEY"),
    ("VOID_CODEBASE", "TROVE_CODEBASE"),
    ("inno-void.bmp", "inno-trove.bmp"),
    ("VoidApp", "TroveApp"),
    ("void.desktop", "trove.desktop"),
    ("void-url-handler.desktop", "trove-url-handler.desktop"),
    ("Exec=void", "Exec=trove"),
    ("StartupWMClass=Void", "StartupWMClass=Trove"),
    ("publisher\": \"voideditor\"", "publisher\": \"troveeditor\""),
]

# Filename renames (basename contains void/Void)
FILENAME_REPLACEMENTS = [
    ("void.contribution.ts", "trove.contribution.ts"),
    ("void.css", "trove.css"),
    ("voidSettingsPane.ts", "troveSettingsPane.ts"),
    ("voidSettingsService.ts", "troveSettingsService.ts"),
    ("voidSettingsTypes.ts", "troveSettingsTypes.ts"),
    ("voidModelService.ts", "troveModelService.ts"),
    ("voidUpdateService.ts", "troveUpdateService.ts"),
    ("voidUpdateServiceTypes.ts", "troveUpdateServiceTypes.ts"),
    ("voidUpdateActions.ts", "troveUpdateActions.ts"),
    ("voidUpdateMainService.ts", "troveUpdateMainService.ts"),
    ("voidSCMService.ts", "troveSCMService.ts"),
    ("voidSCMMainService.ts", "troveSCMMainService.ts"),
    ("voidSCMTypes.ts", "troveSCMTypes.ts"),
    ("voidSelectionHelperWidget.ts", "troveSelectionHelperWidget.ts"),
    ("voidCommandBarService.ts", "troveCommandBarService.ts"),
    ("voidOnboardingService.ts", "troveOnboardingService.ts"),
    ("void-settings-tsx", "trove-settings-tsx"),
    ("void-onboarding", "trove-onboarding"),
    ("void-editor-widgets-tsx", "trove-editor-widgets-tsx"),
    ("void-tooltip", "trove-tooltip"),
    ("VoidOnboarding.tsx", "TroveOnboarding.tsx"),
    ("VoidSelectionHelper.tsx", "TroveSelectionHelper.tsx"),
    ("VoidCommandBar.tsx", "TroveCommandBar.tsx"),
    ("VoidTooltip.tsx", "TroveTooltip.tsx"),
]


def should_skip_path(path: Path) -> bool:
    parts = path.parts
    if "node_modules" in parts or ".git" in parts:
        return True
    if "react" in parts and "out" in parts:
        return True
    return False


def iter_files():
    for base in CONTENT_ROOTS:
        if base.is_file():
            if not should_skip_path(base):
                yield base
            continue
        if not base.exists():
            continue
        for path in base.rglob("*"):
            if path.is_file() and not should_skip_path(path):
                if path.suffix in EXTENSIONS or path.name in ("product.json", "package.json"):
                    yield path


def apply_replacements(text: str) -> str:
    for old, new in REPLACEMENTS:
        text = text.replace(old, new)
    return text


def rename_paths_bottom_up(root: Path):
    """Rename files and directories containing void/Void in their names."""
    all_paths = sorted(root.rglob("*"), key=lambda p: len(p.parts), reverse=True)
    for path in all_paths:
        name = path.name
        new_name = name
        for old, new in FILENAME_REPLACEMENTS:
            if old in new_name:
                new_name = new_name.replace(old, new)
        if new_name != name:
            dest = path.parent / new_name
            if not dest.exists():
                path.rename(dest)
                print(f"RENAMED: {path.relative_to(ROOT)} -> {dest.relative_to(ROOT)}")


def main():
    void_dir = ROOT / "src/vs/workbench/contrib/void"
    trove_dir = ROOT / "src/vs/workbench/contrib/trove"

    if void_dir.exists() and not trove_dir.exists():
        shutil.move(str(void_dir), str(trove_dir))
        print(f"MOVED: {void_dir.relative_to(ROOT)} -> {trove_dir.relative_to(ROOT)}")
    elif trove_dir.exists():
        print("contrib/trove already exists")
    else:
        print("ERROR: contrib/void not found")
        return 1

    rename_paths_bottom_up(trove_dir)

    changed = 0
    for path in iter_files():
        try:
            original = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        updated = apply_replacements(original)
        if updated != original:
            path.write_text(updated, encoding="utf-8")
            changed += 1
            print(f"UPDATED: {path.relative_to(ROOT)}")

    print(f"\nDone. {changed} files updated.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
