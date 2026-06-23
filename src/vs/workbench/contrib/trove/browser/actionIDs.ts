// Normally you'd want to put these exports in the files that register them, but if you do that you'll get an import order error if you import them in certain cases.
// (importing them runs the whole file to get the ID, causing an import error). I guess it's best practice to separate out IDs, pretty annoying...

export const TROVE_CTRL_L_ACTION_ID = 'trove.ctrlLAction'

export const TROVE_CTRL_K_ACTION_ID = 'trove.ctrlKAction'

export const TROVE_ACCEPT_DIFF_ACTION_ID = 'trove.acceptDiff'

export const TROVE_REJECT_DIFF_ACTION_ID = 'trove.rejectDiff'

export const TROVE_GOTO_NEXT_DIFF_ACTION_ID = 'trove.goToNextDiff'

export const TROVE_GOTO_PREV_DIFF_ACTION_ID = 'trove.goToPrevDiff'

export const TROVE_GOTO_NEXT_URI_ACTION_ID = 'trove.goToNextUri'

export const TROVE_GOTO_PREV_URI_ACTION_ID = 'trove.goToPrevUri'

export const TROVE_ACCEPT_FILE_ACTION_ID = 'trove.acceptFile'

export const TROVE_REJECT_FILE_ACTION_ID = 'trove.rejectFile'

export const TROVE_ACCEPT_ALL_DIFFS_ACTION_ID = 'trove.acceptAllDiffs'

export const TROVE_REJECT_ALL_DIFFS_ACTION_ID = 'trove.rejectAllDiffs'

export const TROVE_REMEMBER_THIS_ACTION_ID = 'trove.rememberThis'

export const TROVE_ANALYSE_REPOSITORY_ACTION_ID = 'trove.analyseRepository'

export const TROVE_OPEN_REPO_INTELLIGENCE_REPORT_ACTION_ID = 'trove.openRepoIntelligenceReport'

export const TROVE_OPEN_CONTEXT_GRAPH_ACTION_ID = 'trove.openContextGraph'

export const TROVE_REFRESH_REPO_INDEX_ACTION_ID = 'trove.refreshRepoIndex'
