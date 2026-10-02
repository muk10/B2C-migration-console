'use strict';

/**
 * Mocha --require bootstrap for the bm_accelerator unit suite.
 * Installs the SFCC cartridge/dw module resolver once, before any test file is
 * loaded, so specs that require cartridge modules directly (not only via
 * bulkPipelineRunner) resolve the star/cartridge alias and dw/ APIs correctly.
 */
require('./cartridgeLoader').installCartridgeResolver();
