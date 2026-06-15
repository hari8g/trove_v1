/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { mountFnGenerator } from '../util/mountFnGenerator.js'
import { TroveCommandBarMain } from './TroveCommandBar.js'
import { TroveSelectionHelperMain } from './TroveSelectionHelper.js'

export const mountTroveCommandBar = mountFnGenerator(TroveCommandBarMain)

export const mountTroveSelectionHelper = mountFnGenerator(TroveSelectionHelperMain)

