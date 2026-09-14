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

function sanitizeScope(val) {
    return String(val || '').replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 40);
}

/**
 * Session + file prefix for one generate run.
 * @param {string} [storeKey]
 * @param {boolean} [unassigned]
 * @returns {string}
 */
function filePrefix(storeKey, unassigned) {
    if (unassigned) return 'customers-unassigned';
    var key = sanitizeScope(storeKey);
    return key ? ('customers-' + key) : '';
}

/**
 * Isolate split-runner session keys per source site.
 * @param {string} platformId
 * @param {string} [storeKey]
 * @param {boolean} [unassigned]
 * @returns {string}
 */
function sessionScope(platformId, storeKey, unassigned) {
    var p = String(platformId || 'ctp');
    var extra = filePrefix(storeKey, unassigned);
    return extra ? (p + '_' + extra) : p;
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
    buildPartFileName: buildPartFileName,
    sanitizeScope:     sanitizeScope,
    filePrefix:        filePrefix,
    sessionScope:      sessionScope
};
