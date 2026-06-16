/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { join } from '../../../../base/common/path.js';

export const TROVE_MEMORY_FILE_NAME = 'trove-memory.md';

export const getTroveMemoryFilePath = (userDataPath: string): string => {
	return join(userDataPath, TROVE_MEMORY_FILE_NAME);
};
