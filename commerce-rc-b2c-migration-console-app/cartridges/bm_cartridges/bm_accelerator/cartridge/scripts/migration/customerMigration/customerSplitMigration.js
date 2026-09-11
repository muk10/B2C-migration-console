'use strict';

/* global session */

/**
 * Shared full-migration engine for customer XML.
 * One HTTP request writes a few source pages, then returns so the UI can continue.
 * Files rotate at MAX_PER_FILE — project size is unlimited (p0001, p0002, …).
 */

var File         = require('dw/io/File');
var FileWriter   = require('dw/io/FileWriter');
var fileResolver = require('*/cartridge/scripts/migration/core/migrationFileResolver');
var uploader     = require('*/cartridge/scripts/migration/customerMigration/webDavUploader');
var splitUtils   = require('*/cartridge/scripts/migration/customerMigration/customerSplitUtils');

var MODULE_KEY = 'customer';
var MAX_PER_FILE = splitUtils.MAX_PER_FILE;
var DEFAULT_PAGES_PER_REQUEST = 4;

function sk(platformId, name) {
    return 'migC_' + String(platformId || 'ctp') + '_' + name;
}

function getStr(key) {
    return String(session.custom[key] || '');
}

function setStr(key, val) {
    session.custom[key] = val == null ? '' : String(val);
}

function getNum(key) {
    return parseInt(String(session.custom[key] || 0), 10) || 0;
}

function setNum(key, n) {
    session.custom[key] = String(n || 0);
}

var expectedFileCount = splitUtils.expectedFileCount;
var padPart           = splitUtils.padPart;
var buildPartFileName = splitUtils.buildPartFileName;

function ensureImpexDir(relativePath) {
    var dir = new File(File.IMPEX + File.SEPARATOR + String(relativePath).replace(/\//g, File.SEPARATOR));
    if (!dir.exists()) {
        dir.mkdirs();
    }
    return dir;
}

function resetState(platformId) {
    setStr(sk(platformId, 'cur'), '');
    setNum(sk(platformId, 'part'), 1);
    setNum(sk(platformId, 'inFile'), 0);
    setNum(sk(platformId, 'built'), 0);
    setNum(sk(platformId, 'failed'), 0);
    setNum(sk(platformId, 'total'), 0);
    setStr(sk(platformId, 'file'), '');
    setStr(sk(platformId, 'files'), '');
    setStr(sk(platformId, 'open'), '0');
    setStr(sk(platformId, 'stem'), '');
}

function appendUploadedName(platformId, fileName) {
    var existing = getStr(sk(platformId, 'files'));
    if (!existing) {
        setStr(sk(platformId, 'files'), fileName);
        return;
    }
    var parts = existing.split(',');
    if (parts.indexOf(fileName) === -1) {
        setStr(sk(platformId, 'files'), existing + ',' + fileName);
    }
}

function uploadedList(platformId) {
    var raw = getStr(sk(platformId, 'files'));
    return raw ? raw.split(',') : [];
}

function openPart(platformId, part, xmlHeader) {
    var impexPath = fileResolver.getRelativePath(MODULE_KEY);
    var dir       = ensureImpexDir(impexPath);
    var stem      = getStr(sk(platformId, 'stem'));
    if (!stem) {
        stem = fileResolver.resolveRunFileName(MODULE_KEY, 0, 'webdav');
        setStr(sk(platformId, 'stem'), stem);
    }
    var fileName = buildPartFileName(stem, part);
    var outFile  = new File(dir, fileName);
    var writer   = new FileWriter(outFile, 'UTF-8', false);
    try {
        writer.write(xmlHeader);
    } finally {
        writer.close();
    }
    setStr(sk(platformId, 'file'), fileName);
    setNum(sk(platformId, 'part'), part);
    setNum(sk(platformId, 'inFile'), 0);
    setStr(sk(platformId, 'open'), '1');
    return fileName;
}

function appendBody(fileName, body) {
    if (!body) return;
    var impexPath = fileResolver.getRelativePath(MODULE_KEY);
    var dir       = ensureImpexDir(impexPath);
    var outFile   = new File(dir, fileName);
    var writer    = new FileWriter(outFile, 'UTF-8', true);
    try {
        writer.write(body);
    } finally {
        writer.close();
    }
}

function closeAndUpload(platformId, xmlFooter) {
    var fileName = getStr(sk(platformId, 'file'));
    if (!fileName || getStr(sk(platformId, 'open')) !== '1') {
        return { ok: true, fileName: fileName || '' };
    }
    appendBody(fileName, xmlFooter);
    setStr(sk(platformId, 'open'), '0');
    var put = uploader.uploadLocalFile(fileName);
    if (!put.ok) return put;
    appendUploadedName(platformId, fileName);
    return { ok: true, fileName: fileName };
}

/**
 * Process one UI poll: fetch a few source pages, append XML, rotate files at 20k.
 *
 * @param {Object} opts
 * @param {number} opts.offset - 0 starts a new run; any other value continues session state
 * @param {string} opts.listId
 * @param {string} [opts.platformId] - ctp | shopify | bigcommerce (session isolation)
 * @param {Object} opts.xmlBuilder
 * @param {Function} opts.fetchPage - function(cursor) → { results, total, nextCursor, hasMore }
 * @param {Function} [opts.getCount] - used when the first page omits total
 * @param {number} [opts.pagesPerRequest]
 * @param {number} [opts.maxPerFile]
 * @returns {Object}
 */
function runBatch(opts) {
    opts = opts || {};
    if (!opts.listId) return { ok: false, error: 'listId is required' };
    if (!opts.xmlBuilder || !opts.fetchPage) {
        return { ok: false, error: 'xmlBuilder and fetchPage are required' };
    }

    var platformId      = opts.platformId || 'ctp';
    var xmlBuilder      = opts.xmlBuilder;
    var maxPerFile      = opts.maxPerFile || MAX_PER_FILE;
    var pagesPerRequest = opts.pagesPerRequest || DEFAULT_PAGES_PER_REQUEST;
    var isFirst         = !opts.offset;
    var impexPath       = fileResolver.getRelativePath(MODULE_KEY);

    try {
        if (isFirst) {
            resetState(platformId);
            var dirResult = uploader.ensureDirectory();
            if (!dirResult.ok) {
                return { ok: false, error: 'WebDAV directory creation failed: ' + dirResult.error };
            }
            fileResolver.getRunDate(MODULE_KEY, 0);
            openPart(platformId, 1, xmlBuilder.XML_HEADER);
        }

        if (getStr(sk(platformId, 'open')) !== '1' || !getStr(sk(platformId, 'file'))) {
            openPart(platformId, getNum(sk(platformId, 'part')) || 1, xmlBuilder.XML_HEADER);
        }

        var builtThis       = 0;
        var failedThis      = 0;
        var errors          = [];
        var pages           = 0;
        var sourceExhausted = false;

        while (pages < pagesPerRequest) {
            var cursor = getStr(sk(platformId, 'cur'));
            var page   = opts.fetchPage(cursor || null);
            var customers = (page && page.results) || [];
            pages++;

            if (getNum(sk(platformId, 'total')) === 0) {
                var reported = page && page.total != null ? page.total : 0;
                if (!reported && opts.getCount) {
                    try { reported = opts.getCount(); } catch (ce) { reported = 0; }
                }
                if (reported) setNum(sk(platformId, 'total'), reported);
            }

            if (!customers.length) {
                sourceExhausted = true;
                break;
            }

            var fragment = xmlBuilder.buildCustomerFragment(customers);
            appendBody(getStr(sk(platformId, 'file')), fragment.body);
            builtThis  += fragment.built;
            failedThis += fragment.failed;
            setNum(sk(platformId, 'built'), getNum(sk(platformId, 'built')) + fragment.built);
            setNum(sk(platformId, 'failed'), getNum(sk(platformId, 'failed')) + fragment.failed);
            setNum(sk(platformId, 'inFile'), getNum(sk(platformId, 'inFile')) + fragment.built + fragment.failed);

            if (fragment.errors && fragment.errors.length && errors.length < 5) {
                errors = errors.concat(fragment.errors.slice(0, 5 - errors.length));
            }

            if (page.nextCursor) {
                setStr(sk(platformId, 'cur'), page.nextCursor);
            }
            if (page.hasMore === false) {
                sourceExhausted = true;
            }

            if (getNum(sk(platformId, 'inFile')) >= maxPerFile) {
                var rotated = closeAndUpload(platformId, xmlBuilder.XML_FOOTER);
                if (!rotated.ok) return { ok: false, error: rotated.error };
                setNum(sk(platformId, 'part'), getNum(sk(platformId, 'part')) + 1);
                break;
            }

            if (sourceExhausted) break;
        }

        if (sourceExhausted && getStr(sk(platformId, 'open')) === '1') {
            var finished = closeAndUpload(platformId, xmlBuilder.XML_FOOTER);
            if (!finished.ok) return { ok: false, error: finished.error };
        }

        var total     = getNum(sk(platformId, 'total'));
        var built     = getNum(sk(platformId, 'built'));
        var failed    = getNum(sk(platformId, 'failed'));
        var processed = built + failed;
        var files     = uploadedList(platformId);
        var expected  = expectedFileCount(total, maxPerFile);
        var filePart  = getNum(sk(platformId, 'part')) || 1;
        var done      = sourceExhausted;
        if (!done && getStr(sk(platformId, 'open')) !== '1') {
            filePart = Math.max(1, filePart - 1);
        }

        if (!done && processed > 0 && total > 0 && processed >= total) {
            if (getStr(sk(platformId, 'open')) === '1') {
                var forceClose = closeAndUpload(platformId, xmlBuilder.XML_FOOTER);
                if (!forceClose.ok) return { ok: false, error: forceClose.error };
            }
            done = true;
        }

        return {
            ok:            true,
            total:         total,
            nextOffset:    processed,
            done:          done,
            built:         builtThis,
            failed:        failedThis,
            errors:        errors,
            fileName:      getStr(sk(platformId, 'file')),
            filePart:      filePart,
            fileCount:     files.length || (done ? 0 : 1),
            expectedFiles: expected,
            files:         files.join(','),
            runDate:       fileResolver.getRunDate(MODULE_KEY, 1),
            impexPath:     impexPath
        };
    } catch (e) {
        return { ok: false, error: e.message || String(e) };
    }
}

module.exports = {
    MODULE_KEY:                MODULE_KEY,
    MAX_PER_FILE:              MAX_PER_FILE,
    DEFAULT_PAGES_PER_REQUEST: DEFAULT_PAGES_PER_REQUEST,
    expectedFileCount:         expectedFileCount,
    padPart:                   padPart,
    buildPartFileName:         buildPartFileName,
    runBatch:                  runBatch
};
