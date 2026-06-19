/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// past values:
// 'trove.settingsServiceStorage'
// 'trove.settingsServiceStorageI' // 1.0.2

// 1.0.3
export const TROVE_SETTINGS_STORAGE_KEY = 'trove.settingsServiceStorageII'


// past values:
// 'trove.chatThreadStorage'
// 'trove.chatThreadStorageI' // 1.0.2

// 1.0.3
export const THREAD_STORAGE_KEY = 'trove.chatThreadStorageII'



export const OPT_OUT_KEY = 'trove.app.optOutAll'

/** Rolling MeteringSession (daily buckets, per-provider, per-thread). */
export const STORAGE_KEY_METERING_SESSION = 'trove.metering.session'

/** Optional budget cap in USD (string-serialised float). */
export const STORAGE_KEY_METERING_BUDGET = 'trove.metering.budget'
