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
var storeBuckets = require('*/cartridge/scripts/migration/customerMigration/customerStoreBuckets');

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

function listedBuckets(platformId) {
    var raw = getStr(sk(platformId, 'bkts'));
    return raw ? raw.split(',') : [];
}

function rememberBucket(platformId, bucket) {
    var existing = getStr(sk(platformId, 'bkts'));
    if (!existing) {
        setStr(sk(platformId, 'bkts'), bucket);
        return;
    }
    var parts = existing.split(',');
    if (parts.indexOf(bucket) === -1) {
        setStr(sk(platformId, 'bkts'), existing + ',' + bucket);
    }
}

function platformForBucket(baseId, bucket) {
    if (!bucket || bucket === storeBuckets.UNASSIGNED) return baseId;
    return splitUtils.sessionScope(baseId, bucket, false);
}

function prefixForBucket(bucket) {
    if (!bucket || bucket === storeBuckets.UNASSIGNED) return '';
    return splitUtils.filePrefix(bucket, false);
}

function resetAllBuckets(platformId) {
    var prev = listedBuckets(platformId);
    var i;
    for (i = 0; i < prev.length; i++) {
        resetState(platformForBucket(platformId, prev[i]));
    }
    resetState(platformId);
    setStr(sk(platformId, 'bkts'), '');
    setStr(sk(platformId, 'idmap'), '');
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

function openPart(platformId, part, xmlHeader, filePrefix) {
    var impexPath = fileResolver.getRelativePath(MODULE_KEY);
    var dir       = ensureImpexDir(impexPath);
    var stem      = getStr(sk(platformId, 'stem'));
    if (!stem) {
        stem = fileResolver.resolveRunFileName(MODULE_KEY, 0, 'webdav', filePrefix || '');
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

function allUploadedFiles(platformId) {
    var names = uploadedList(platformId);
    var buckets = listedBuckets(platformId);
    var b;
    for (b = 0; b < buckets.length; b++) {
        var pid = platformForBucket(platformId, buckets[b]);
        if (pid === platformId) continue;
        var extra = uploadedList(pid);
        var e;
        for (e = 0; e < extra.length; e++) {
            if (extra[e] && names.indexOf(extra[e]) === -1) names.push(extra[e]);
        }
        var openName = getStr(sk(pid, 'file'));
        if (openName && getStr(sk(pid, 'open')) === '1' && names.indexOf(openName) === -1) {
            names.push(openName);
        }
    }
    var baseOpen = getStr(sk(platformId, 'file'));
    if (baseOpen && getStr(sk(platformId, 'open')) === '1' && names.indexOf(baseOpen) === -1) {
        names.push(baseOpen);
    }
    return names;
}

function writeGroup(pid, prefix, customers, xmlBuilder, maxPerFile, errors) {
    if (getStr(sk(pid, 'open')) !== '1' || !getStr(sk(pid, 'file'))) {
        openPart(pid, getNum(sk(pid, 'part')) || 1, xmlBuilder.XML_HEADER, prefix);
    }
    var fragment = xmlBuilder.buildCustomerFragment(customers);
    appendBody(getStr(sk(pid, 'file')), fragment.body);
    setNum(sk(pid, 'inFile'), getNum(sk(pid, 'inFile')) + fragment.built + fragment.failed);
    if (fragment.errors && fragment.errors.length && errors.length < 5) {
        var add = fragment.errors.slice(0, 5 - errors.length);
        var a;
        for (a = 0; a < add.length; a++) errors.push(add[a]);
    }
    if (getNum(sk(pid, 'inFile')) >= maxPerFile) {
        var rotated = closeAndUpload(pid, xmlBuilder.XML_FOOTER);
        if (!rotated.ok) return rotated;
        setNum(sk(pid, 'part'), getNum(sk(pid, 'part')) + 1);
    }
    return { ok: true, built: fragment.built, failed: fragment.failed };
}

function closeOpenBuckets(platformId, xmlFooter) {
    var targets = [platformId];
    var buckets = listedBuckets(platformId);
    var i;
    for (i = 0; i < buckets.length; i++) {
        var pid = platformForBucket(platformId, buckets[i]);
        if (targets.indexOf(pid) === -1) targets.push(pid);
    }
    for (i = 0; i < targets.length; i++) {
        if (getStr(sk(targets[i], 'open')) === '1') {
            var closed = closeAndUpload(targets[i], xmlFooter);
            if (!closed.ok) return closed;
        }
    }
    return { ok: true };
}

/**
 * Process one UI poll: fetch a few source pages, append XML, rotate files at 20k.
 *
 * @param {Object} opts
 * @param {number} opts.offset - 0 starts a new run; any other value continues session state
 * @param {string} [opts.platformId]
 * @param {string} [opts.filePrefix]
 * @param {boolean} [opts.bucketCustomers] - split by Customer.stores while writing
 * @param {Object} [opts.idToKey] - store id → key for file names
 * @param {Object} opts.xmlBuilder
 * @param {Function} opts.fetchPage
 * @param {Function} [opts.getCount]
 * @returns {Object}
 */
function runBatch(opts) {
    opts = opts || {};
    if (!opts.xmlBuilder || !opts.fetchPage) {
        return { ok: false, error: 'xmlBuilder and fetchPage are required' };
    }

    var platformId      = opts.platformId || 'ctp';
    var filePrefix      = opts.filePrefix || '';
    var xmlBuilder      = opts.xmlBuilder;
    var maxPerFile      = opts.maxPerFile || MAX_PER_FILE;
    var pagesPerRequest = opts.pagesPerRequest || DEFAULT_PAGES_PER_REQUEST;
    var bucketCustomers = !!opts.bucketCustomers;
    var idToKey         = opts.idToKey || {};
    var isFirst         = !opts.offset;
    var impexPath       = fileResolver.getRelativePath(MODULE_KEY);

    try {
        if (isFirst) {
            resetAllBuckets(platformId);
            var dirResult = uploader.ensureDirectory();
            if (!dirResult.ok) {
                return { ok: false, error: 'WebDAV directory creation failed: ' + dirResult.error };
            }
            fileResolver.getRunDate(MODULE_KEY, 0, filePrefix);
            if (!bucketCustomers) {
                openPart(platformId, 1, xmlBuilder.XML_HEADER, filePrefix);
            }
        }

        if (!bucketCustomers && (getStr(sk(platformId, 'open')) !== '1' || !getStr(sk(platformId, 'file')))) {
            openPart(platformId, getNum(sk(platformId, 'part')) || 1, xmlBuilder.XML_HEADER, filePrefix);
        }

        var builtThis       = 0;
        var failedThis      = 0;
        var errors          = [];
        var pages           = 0;
        var sourceExhausted = false;
        var rotated         = false;

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

            if (bucketCustomers) {
                var groups = storeBuckets.groupByBucket(customers, idToKey);
                var bucket;
                for (var bucket in groups) {
                    if (!Object.prototype.hasOwnProperty.call(groups, bucket)) continue;
                    rememberBucket(platformId, bucket);
                    var pid = platformForBucket(platformId, bucket);
                    var prefix = prefixForBucket(bucket);
                    var written = writeGroup(pid, prefix, groups[bucket], xmlBuilder, maxPerFile, errors);
                    if (!written.ok) return { ok: false, error: written.error };
                    if (getStr(sk(pid, 'open')) !== '1') rotated = true;
                }
                builtThis += customers.length;
                setNum(sk(platformId, 'built'), getNum(sk(platformId, 'built')) + customers.length);
            } else {
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
                if (getNum(sk(platformId, 'inFile')) >= maxPerFile) {
                    var oneRotate = closeAndUpload(platformId, xmlBuilder.XML_FOOTER);
                    if (!oneRotate.ok) return { ok: false, error: oneRotate.error };
                    setNum(sk(platformId, 'part'), getNum(sk(platformId, 'part')) + 1);
                    rotated = true;
                }
            }

            if (page.nextCursor) {
                setStr(sk(platformId, 'cur'), page.nextCursor);
            }
            if (page.hasMore === false) {
                sourceExhausted = true;
            }

            if (rotated || sourceExhausted) break;
        }

        if (sourceExhausted) {
            var finished = closeOpenBuckets(platformId, xmlBuilder.XML_FOOTER);
            if (!finished.ok) return { ok: false, error: finished.error };
        }

        var total     = getNum(sk(platformId, 'total'));
        var built     = getNum(sk(platformId, 'built'));
        var failed    = getNum(sk(platformId, 'failed'));
        var processed = built + failed;
        var files     = bucketCustomers ? allUploadedFiles(platformId) : uploadedList(platformId);
        var expected  = expectedFileCount(total, maxPerFile);
        var filePart  = getNum(sk(platformId, 'part')) || 1;
        var done      = sourceExhausted;
        if (!done && getStr(sk(platformId, 'open')) !== '1') {
            filePart = Math.max(1, filePart - 1);
        }

        if (!done && processed > 0 && total > 0 && processed >= total) {
            var forceClose = closeOpenBuckets(platformId, xmlBuilder.XML_FOOTER);
            if (!forceClose.ok) return { ok: false, error: forceClose.error };
            done = true;
        }

        var buckets = listedBuckets(platformId);
        var storeBucketsUsed = 0;
        var bi;
        for (bi = 0; bi < buckets.length; bi++) {
            if (buckets[bi] && buckets[bi] !== storeBuckets.UNASSIGNED) storeBucketsUsed++;
        }

        return {
            ok:            true,
            total:         total,
            nextOffset:    processed,
            done:          done,
            built:         builtThis,
            failed:        failedThis,
            errors:        errors,
            fileName:      getStr(sk(platformId, 'file')) || (files.length ? files[files.length - 1] : ''),
            filePart:      filePart,
            fileCount:     files.length || (done ? 0 : 1),
            expectedFiles: expected,
            files:         files.join(','),
            storeBuckets:  storeBucketsUsed,
            runDate:       fileResolver.getRunDate(MODULE_KEY, 1, filePrefix),
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
