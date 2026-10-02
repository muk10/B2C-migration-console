'use strict';

/**
 * Resolve SFCC cartridge module paths (star/cartridge alias) for Node/Mocha unit tests.
 * Call installCartridgeResolver() once before requiring migration scripts.
 */
var Module = require('module');
var path   = require('path');
var fs     = require('fs');

var CARTRIDGE_ROOT = path.resolve(__dirname, '../../../../commerce-rc-b2c-migration-console-app/cartridges/bm_cartridges/bm_accelerator/cartridge');
var MOCK_ROOT      = path.resolve(__dirname, '../mocks');
var AUTO_DW_MOCK   = path.join(MOCK_ROOT, '_autoDw.js');
var originalResolve = Module._resolveFilename;
var installed = false;

function installCartridgeResolver() {
    if (installed) return;
    installed = true;

    Module._resolveFilename = function (request, parent, isMain, options) {
        if (request.indexOf('dw/') === 0) {
            var mockPath = path.join(MOCK_ROOT, request + '.js');
            if (fs.existsSync(mockPath)) {
                return originalResolve.call(this, mockPath, parent, isMain, options);
            }
            // No dedicated mock for this dw/* API — fall back to a permissive
            // auto-stub so the module can load. Dedicated mocks above still win.
            return originalResolve.call(this, AUTO_DW_MOCK, parent, isMain, options);
        }
        if (request.indexOf('*/cartridge/') === 0) {
            var mapped = path.join(CARTRIDGE_ROOT, request.replace('*/cartridge/', ''));
            return originalResolve.call(this, mapped, parent, isMain, options);
        }
        return originalResolve.call(this, request, parent, isMain, options);
    };
}

function requireCartridge(relativePath) {
    installCartridgeResolver();
    var id = '*/cartridge/scripts/migration/' + relativePath;
    return require(id);
}

function getCartridgeRoot() {
    return CARTRIDGE_ROOT;
}

module.exports = {
    installCartridgeResolver: installCartridgeResolver,
    requireCartridge:         requireCartridge,
    getCartridgeRoot:         getCartridgeRoot
};
