'use strict';

var File         = require('dw/io/File');
var FileWriter   = require('dw/io/FileWriter');
var registry     = require('*/cartridge/scripts/migration/core/dataSourceRegistry');
var fetcher      = registry.getFetcher('inventory');
var transformer  = require('*/cartridge/scripts/migration/inventoryMigration/inventoryTransformer');
var xmlBuilder   = require('*/cartridge/scripts/migration/inventoryMigration/inventoryXmlBuilder');
var uploader     = require('*/cartridge/scripts/migration/inventoryMigration/webDavUploader');
var fileResolver = require('*/cartridge/scripts/migration/core/migrationFileResolver');
var fileNaming   = require('*/cartridge/scripts/migration/inventoryMigration/inventoryFileNaming');

var MODULE_KEY              = 'inventory';
var BATCH_SIZE              = 500;
var MAX_SINGLE_FILE_ENTRIES = 100000;

function buildDescription(exportKey, supplyChannelId) {
    var registry = require('*/cartridge/scripts/migration/core/dataSourceRegistry');
    var src      = registry.getSourceLabel(registry.getPlatformId());
    var desc     = src + ' inventory migration';
    if (exportKey === 'aggregated') {
        desc += ' (aggregated all channels)';
    } else if (supplyChannelId) {
        desc += ' (supply channel ' + supplyChannelId + ')';
    }
    return desc;
}

function closeWriterSafe(writer) {
    if (writer) {
        try { writer.close(); } catch (e) { /* ignore */ }
    }
}

function removeLocalFile(file) {
    if (file && file.exists()) {
        try { file.remove(); } catch (e) { /* ignore */ }
    }
}

function ensureImpexDir(relativePath) {
    var dir = new File(File.IMPEX + File.SEPARATOR + String(relativePath).replace(/\//g, File.SEPARATOR));
    if (!dir.exists()) {
        dir.mkdirs();
    }
    return dir;
}

/**
 * @param {Array} records
 * @param {string} listId
 * @param {string} exportKey
 * @param {string} supplyChannelId
 * @param {string} fileName
 * @returns {Object}
 */
function uploadXml(records, listId, exportKey, supplyChannelId, fileName, offset) {
    if (!records || !records.length) {
        return { ok: true, built: 0, failed: 0, errors: [], fileName: null };
    }

    var fileOffset = offset || 0;
    var runDate    = fileResolver.getRunDate(MODULE_KEY + '_' + fileNaming.exportKeySafe(exportKey), fileOffset);
    var resolved   = fileNaming.resolveFileName(exportKey, fileOffset, BATCH_SIZE, fileName);
    var impexPath  = fileResolver.getRelativePath(MODULE_KEY);
    var buildResult = xmlBuilder.buildXml(records, listId, buildDescription(exportKey, supplyChannelId));
    var dirResult   = uploader.ensureDirectory();
    if (!dirResult.ok) {
        return { ok: false, error: 'WebDAV directory creation failed: ' + dirResult.error };
    }

    var putResult = uploader.uploadFile(resolved, buildResult.xml);
    if (!putResult.ok) {
        return { ok: false, error: 'WebDAV upload failed: ' + putResult.error };
    }

    return {
        ok:        true,
        built:     buildResult.built,
        failed:    buildResult.failed,
        errors:    buildResult.errors,
        fileName:  resolved,
        runDate:   runDate,
        impexPath: impexPath
    };
}

/**
 * Stream CT inventory into one IMPEX file without holding all entries in memory.
 * Aggregated mode sorts by SKU and merges consecutive rows (one pending record at a time).
 */
function runSingleFile(listId, supplyChannelId, exportKey, fileName, aggregate) {
    var channelId = (supplyChannelId && supplyChannelId !== 'all') ? supplyChannelId : '';
    var impexPath = fileResolver.getRelativePath(MODULE_KEY);
    var resolved  = fileNaming.resolveFileName(exportKey, 0, BATCH_SIZE, fileName);
    var runDate   = fileResolver.getRunDate(MODULE_KEY + '_' + fileNaming.exportKeySafe(exportKey), 0);
    var dir       = ensureImpexDir(impexPath);
    var outFile   = new File(dir, resolved);
    var writer    = null;
    var built     = 0;
    var failed    = 0;
    var errors    = [];
    var offset    = 0;
    var total     = 0;
    var results   = [];
    var pending   = null;
    var sortField = aggregate ? 'sku' : 'id';
    var headerWritten = false;
    var complete      = false;
    var description   = buildDescription(exportKey, channelId || null);

    function flushPending() {
        if (!pending || !writer) return;
        try {
            writer.write(xmlBuilder.buildRecordXml(pending));
            built++;
        } catch (e) {
            failed++;
            if (errors.length < 5) {
                errors.push((pending.sku || '?') + ': ' + (e.message || String(e)));
            }
        }
        pending = null;
    }

    try {
        var dirResult = uploader.ensureDirectory();
        if (!dirResult.ok) {
            return { ok: false, error: 'WebDAV directory creation failed: ' + dirResult.error };
        }

        writer = new FileWriter(outFile, 'UTF-8');

        do {
            var batch = fetcher.fetchBatch(offset, BATCH_SIZE, channelId, sortField);
            results   = batch.results || [];
            total     = batch.total || 0;

            if (!headerWritten) {
                writer.write(xmlBuilder.buildHeader(listId, description));
                headerWritten = true;
            }

            if (offset === 0 && total > MAX_SINGLE_FILE_ENTRIES) {
                return {
                    ok:    false,
                    error: 'Too many entries (' + total + ') for a single XML file. '
                        + 'Maximum is ' + MAX_SINGLE_FILE_ENTRIES + '.'
                };
            }

            var i;
            for (i = 0; i < results.length; i++) {
                try {
                    var rec = transformer.transformEntry(results[i]);
                    if (!rec) {
                        failed++;
                        continue;
                    }

                    if (aggregate) {
                        var recKey = rec.productId || rec.sku;
                        var pendingKey = pending ? (pending.productId || pending.sku) : '';
                        if (pending && pendingKey === recKey) {
                            transformer.mergeRecords(pending, rec);
                        } else {
                            flushPending();
                            pending = rec;
                        }
                    } else {
                        writer.write(xmlBuilder.buildRecordXml(rec));
                        built++;
                    }
                } catch (te) {
                    failed++;
                    if (errors.length < 5) {
                        errors.push('entry: ' + (te.message || String(te)));
                    }
                }
            }

            offset = typeof batch.streamOffset === 'number'
                ? batch.streamOffset
                : (offset + results.length);
        } while (offset < total && results.length > 0);

        if (!headerWritten) {
            writer.write(xmlBuilder.buildHeader(listId, description));
            headerWritten = true;
        }

        flushPending();
        writer.write(xmlBuilder.buildFooter());
        closeWriterSafe(writer);
        writer = null;
        complete = true;

        if (!built && !failed) {
            return {
                ok:         true,
                singleFile: true,
                total:      total,
                nextOffset: 0,
                done:       true,
                built:      0,
                failed:     0,
                errors:     [],
                impexPath:  impexPath,
                exportKey:  exportKey
            };
        }

        var putResult = uploader.uploadLocalFile(resolved);
        if (!putResult.ok) {
            return { ok: false, error: putResult.error };
        }

        return {
            ok:         true,
            singleFile: true,
            total:      total,
            nextOffset: total,
            done:       true,
            built:      built,
            failed:     failed,
            errors:     errors,
            fileName:   resolved,
            runDate:    runDate,
            impexPath:  impexPath,
            exportKey:  exportKey
        };
    } catch (e) {
        return { ok: false, error: e.message || String(e) };
    } finally {
        if (writer) {
            try {
                if (headerWritten) {
                    writer.write(xmlBuilder.buildFooter());
                }
            } catch (fe) { /* ignore */ }
            closeWriterSafe(writer);
        }
        if (!complete) {
            removeLocalFile(outFile);
        }
    }
}

/**
 * Paginated inventory export — one IMPEX file per batch (legacy multi-file mode).
 */
function runMultiFileBatch(offset, listId, supplyChannelId, exportKey, fileName, aggregate) {
    var channelId = (supplyChannelId && supplyChannelId !== 'all') ? supplyChannelId : '';
    var batch     = fetcher.fetchBatch(offset, BATCH_SIZE, channelId);
    var entries   = batch.results;
    var total     = batch.total;

    if (!entries || entries.length === 0) {
        return {
            ok: true, total: total, nextOffset: offset, done: true,
            built: 0, failed: 0, errors: [],
            impexPath: fileResolver.getRelativePath(MODULE_KEY)
        };
    }

    var records = aggregate
        ? transformer.aggregateBySku(entries)
        : entries.map(function (e) { return transformer.transformEntry(e); }).filter(function (r) { return !!r; });

    var upload = uploadXml(records, listId, exportKey, channelId || null, fileName, offset);
    if (!upload.ok) {
        return { ok: false, error: upload.error };
    }

    var nextOffset = typeof batch.streamOffset === 'number'
        ? batch.streamOffset
        : (offset + entries.length);
    return {
        ok:         true,
        singleFile: false,
        total:      total,
        nextOffset: nextOffset,
        done:       nextOffset >= total || entries.length === 0,
        built:      upload.built,
        failed:     upload.failed,
        errors:     upload.errors,
        fileName:   upload.fileName,
        runDate:    upload.runDate,
        impexPath:  upload.impexPath,
        exportKey:  exportKey
    };
}

/**
 * @param {number} offset
 * @param {string} listId
 * @param {string} [supplyChannelId]
 * @param {string} [exportKey]
 * @param {string} [fileName]
 * @param {boolean} [aggregate]
 * @param {boolean} [singleFile] - default true: one IMPEX file per export target
 * @returns {Object}
 */
function runBatch(offset, listId, supplyChannelId, exportKey, fileName, aggregate, singleFile) {
    if (!listId) return { ok: false, error: 'listId is required' };
    if (!exportKey) return { ok: false, error: 'exportKey is required' };

    var useSingleFile = singleFile !== false;

    if (useSingleFile) {
        if (offset > 0) {
            return {
                ok:         true,
                singleFile: true,
                total:      offset,
                nextOffset: offset,
                done:       true,
                built:      0,
                failed:     0,
                errors:     [],
                impexPath:  fileResolver.getRelativePath(MODULE_KEY),
                exportKey:  exportKey
            };
        }
        return runSingleFile(listId, supplyChannelId, exportKey, fileName, aggregate);
    }

    return runMultiFileBatch(offset, listId, supplyChannelId, exportKey, fileName, aggregate);
}

module.exports = {
    BATCH_SIZE:              BATCH_SIZE,
    MAX_SINGLE_FILE_ENTRIES: MAX_SINGLE_FILE_ENTRIES,
    runBatch:                runBatch
};
