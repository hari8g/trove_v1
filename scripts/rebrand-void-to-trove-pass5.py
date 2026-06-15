#!/usr/bin/env python3
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
TROVE = ROOT / "src/vs/workbench/contrib/trove"
R = [
    ("scheme: 'void'", "scheme: 'trove'"),
    ("void-repo-intelligence.db", "trove-repo-intelligence.db"),
    ("'voidVoidModelService'", "'troveModelService'"),
    ("voidVoidModelService", "troveModelService"),
    ("'voidDirectoryStrService'", "'troveDirectoryStrService'"),
    ("Vertex with Void.", "Vertex with Trove."),
    (".void-force-child-placeholder", ".trove-force-child-placeholder"),
    ("void-view-icon", "trove-view-icon"),
    ("voidContainer", "troveContainer"),
    ("voidChat", "troveChat"),
    ("voidAcceptDiffAction", "troveAcceptDiffAction"),
    ("voidRejectDiffAction", "troveRejectDiffAction"),
    ("voidGoToNextDiffAction", "troveGoToNextDiffAction"),
    ("voidGoToPrevDiffAction", "troveGoToPrevDiffAction"),
    ("voidGoToNextUriAction", "troveGoToNextUriAction"),
    ("voidGoToPrevUriAction", "troveGoToPrevUriAction"),
    ("voidAcceptFileAction", "troveAcceptFileAction"),
    ("voidRejectFileAction", "troveRejectFileAction"),
    ("voidAcceptAllDiffsAction", "troveAcceptAllDiffsAction"),
    ("voidRejectAllDiffsAction", "troveRejectAllDiffsAction"),
    ("voidDebugInfo", "troveDebugInfo"),
    ("voidMetricsDebug", "troveMetricsDebug"),
    ("Open Void's settings", "Open Trove's settings"),
    ("called on void.acceptDiff", "called on trove.acceptDiff"),
    ("called on void.rejectDiff", "called on trove.rejectDiff"),
    ("Application Support/Void", "Application Support/Trove"),
    ("void-watermark-button", "trove-watermark-button"),
]
for p in TROVE.rglob("*"):
    if p.suffix not in {".ts", ".tsx", ".js", ".css"}: continue
    if "/out/" in str(p): continue
    t = p.read_text(encoding="utf-8"); u = t
    for a,b in R: u = u.replace(a,b)
    if u!=t: p.write_text(u,encoding="utf-8"); print(p.relative_to(ROOT))
