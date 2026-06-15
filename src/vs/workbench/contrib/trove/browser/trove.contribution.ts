/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/


// register inline diffs
import './editCodeService.js'

// register Sidebar pane, state, actions (keybinds, menus) (Ctrl+L)
import './sidebarActions.js'
import './sidebarPane.js'

// register quick edit (Ctrl+K)
import './quickEditActions.js'


// register Autocomplete
import './autocompleteService.js'

// register Context services
import './contextGatheringService.js'
// import './contextUserChangesService.js'

// settings pane
import './troveSettingsPane.js'

// register css
import './media/trove.css'

// update (frontend part, also see platform/)
import './troveUpdateActions.js'

// tools
import './toolsService.js'
import './terminalToolService.js'
import './agentDeliveryService.js'

// register Thread History
import './chatThreadService.js'

// ping
import './metricsPollService.js'

// helper services
import './helperServices/consistentItemService.js'

// register selection helper
import './troveSelectionHelperWidget.js'

// register tooltip service
import './tooltipService.js'

// register onboarding service
import './troveOnboardingService.js'

// register misc service
import './miscWokrbenchContrib.js'

// register file service (for explorer context menu)
import './fileService.js'

// register source control management
import './troveSCMService.js'

// register repository intelligence
import './repoIntelligenceService.js'
import './repoIntelligenceStatusContribution.js'

// ---------- common (unclear if these actually need to be imported, because they're already imported wherever they're used) ----------

// llmMessage
import '../common/sendLLMMessageService.js'

// troveSettings
import '../common/troveSettingsService.js'

// refreshModel
import '../common/refreshModelService.js'

// metrics
import '../common/metricsService.js'

// updates
import '../common/troveUpdateService.js'

// model service
import '../common/troveModelService.js'
