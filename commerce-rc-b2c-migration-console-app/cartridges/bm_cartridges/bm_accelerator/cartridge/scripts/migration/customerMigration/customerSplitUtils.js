'use strict';

/**
 * Pure helpers for customer XML file splitting. No dw.* — safe for unit tests.
 */

var MAX_PER_FILE = 20000;

function expectedFileCount(total, maxPerFile) {
    var max = maxPerFile || MAX_PER_FILE;
    if (!total || total < 1) return 1;
    return Math.ceil(total / max);
}

function padPart(part) {
    var p = String(part < 1 ? 1 : part);
    while (p.length < 4) p = '0' + p;
    return p;
}

function buildPartFileName(stem, part) {
    var base = String(stem || 'customer.xml');
    if (/\.xml$/i.test(base)) {
        return base.replace(/\.xml$/i, '-p' + padPart(part) + '.xml');
    }
    return base + '-p' + padPart(part) + '.xml';
}

module.exports = {
    MAX_PER_FILE:      MAX_PER_FILE,
    expectedFileCount: expectedFileCount,
    padPart:           padPart,
    buildPartFileName: buildPartFileName
};
