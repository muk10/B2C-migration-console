'use strict';

var fileResolver = require('*/cartridge/scripts/migration/core/migrationFileResolver');

var MODULE_KEY = 'store';
var MAX_VERSION = 999;

function exportKeySafe(exportKey) {
    return String(exportKey || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function sanitizeFileName(name) {
    var n = String(name || '').trim().replace(/\\/g, '/').split('/').pop();
    if (!n) return '';
    n = n.replace(/[^a-zA-Z0-9._-]/g, '_');
    if (!/\.xml$/i.test(n)) {
        n += '.xml';
    }
    return n;
}

function batchFileName(customFileName, batchIndex) {
    var sanitized = sanitizeFileName(customFileName);
    var base = sanitized.replace(/\.xml$/i, '').replace(/-v\d{3}$/i, '');
    var ver = (batchIndex || 0) + 1;
    var vs = String(ver);
    while (vs.length < 3) {
        vs = '0' + vs;
    }
    return base + '-v' + vs + '.xml';
}

function resolveFileName(exportKey, offset, batchSize, customFileName) {
    var impexPath  = fileResolver.getRelativePath(MODULE_KEY);
    var batchIndex = Math.floor((offset || 0) / (batchSize || 500));
    var runDate    = fileResolver.getRunDate(MODULE_KEY + '_' + exportKeySafe(exportKey), offset);

    if (customFileName) {
        var candidate = batchFileName(customFileName, batchIndex);
        var version   = batchIndex + 1;
        // The export is written under IMPEX, so look there: a WebDAV HEAD needs a BM login that
        // basic auth may refuse, and then every re-export reused -v001 and overwrote the last file.
        while (version <= MAX_VERSION && fileResolver.localFileExists(impexPath + '/' + candidate)) {
            var base = sanitizeFileName(customFileName).replace(/\.xml$/i, '').replace(/-v\d{3}$/i, '');
            var vs = String(version);
            while (vs.length < 3) {
                vs = '0' + vs;
            }
            candidate = base + '-v' + vs + '.xml';
            version++;
        }
        return candidate;
    }

    return batchFileName('store-' + exportKeySafe(exportKey) + '-' + runDate + '-v001.xml', batchIndex);
}

module.exports = {
    sanitizeFileName: sanitizeFileName,
    batchFileName:    batchFileName,
    resolveFileName:  resolveFileName,
    exportKeySafe:    exportKeySafe
};
