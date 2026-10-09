'use strict';

var registry     = require('*/cartridge/scripts/migration/core/dataSourceRegistry');
var fetcher      = registry.getFetcher('store');
var transformer  = require('*/cartridge/scripts/migration/storeMigration/storeTransformer');
var xmlBuilder   = require('*/cartridge/scripts/migration/storeMigration/storeXmlBuilder');
var uploader     = require('*/cartridge/scripts/migration/storeMigration/webDavUploader');
var fileResolver = require('*/cartridge/scripts/migration/core/migrationFileResolver');
var fileNaming   = require('*/cartridge/scripts/migration/storeMigration/storeFileNaming');
var streamWriter = require('*/cartridge/scripts/migration/core/impexStreamWriter');

var MODULE_KEY              = 'store';
var BATCH_SIZE              = 500;
var MAX_SINGLE_FILE_ENTRIES = 10000;

function writeStore(writer, record, stats) {
    try {
        writer.write(xmlBuilder.buildStoreXml(record));
        stats.built++;
    } catch (e) {
        stats.failed++;
        if (stats.errors.length < 5) {
            stats.errors.push((record.storeId || '?') + ': ' + (e.message || String(e)));
        }
    }
}

function buildRefSet(keys) {
    if (!keys || !keys.length) return null;
    var refSet = {};
    var i;
    for (i = 0; i < keys.length; i++) {
        refSet[String(keys[i])] = true;
    }
    return refSet;
}

/**
 * Store type the user chose on the page, else the suggested one.
 * @param {Object} store - source store
 * @param {Object.<string, string>|null} types - ref → physical | online
 * @param {Object} channelMap
 * @returns {string}
 */
function storeTypeFor(store, types, channelMap) {
    var ref = transformer.toMigrationRef(store);
    if (types && types[ref]) return String(types[ref]);
    return transformer.classifyStore(store, channelMap).type;
}

/**
 * @param {string} exportKey
 * @param {string} [fileName]
 * @param {Array<string>} [keys] - selected store refs
 * @param {{ types?: Object.<string, string>, idSource?: string }} [options] - store type per ref
 *   (only physical stores become SFCC stores) and the store ID source (key, id or name)
 * @returns {Object}
 */
function runSingleFile(exportKey, fileName, keys, options) {
    var opts       = options || {};
    var impexPath  = fileResolver.getRelativePath(MODULE_KEY);
    var resolved   = fileNaming.resolveFileName(exportKey, 0, BATCH_SIZE, fileName);
    var runDate    = fileResolver.getRunDate(MODULE_KEY + '_' + fileNaming.exportKeySafe(exportKey), 0);
    var refSet     = buildRefSet(keys);
    var channelMap = fetcher.fetchChannelMap();
    var writer     = null;
    var stats      = { built: 0, failed: 0, errors: [], online: 0, warnings: 0 };
    var seenIds    = {};
    var offset     = 0;
    var total      = 0;
    var results    = [];
    var matched    = 0;

    try {
        var dirResult = uploader.ensureDirectory();
        if (!dirResult.ok) {
            return { ok: false, error: 'WebDAV directory creation failed: ' + dirResult.error };
        }

        var stream = streamWriter.openWriter(impexPath, resolved);
        writer = stream.writer;
        writer.write(xmlBuilder.buildHeader());

        do {
            var batch = fetcher.fetchBatch(offset, BATCH_SIZE);
            results   = batch.results || [];
            total     = batch.total || 0;

            if (offset === 0 && !refSet && total > MAX_SINGLE_FILE_ENTRIES) {
                streamWriter.closeWriter(writer);
                return {
                    ok:    false,
                    error: 'Too many stores (' + total + ') for a single XML file. '
                        + 'Maximum is ' + MAX_SINGLE_FILE_ENTRIES + '.'
                };
            }

            var i;
            for (i = 0; i < results.length; i++) {
                if (!fetcher.storeMatchesRef(results[i], refSet)) {
                    continue;
                }
                matched++;
                // An online store (a sales channel) is site setup, not an SFCC store.
                if (storeTypeFor(results[i], opts.types || null, channelMap) !== transformer.STORE_TYPES.PHYSICAL) {
                    stats.online++;
                    continue;
                }
                var records = transformer.buildStoreRecords([results[i]], channelMap, null, { idSource: opts.idSource });
                if (!records || !records.length) {
                    stats.failed++;
                    continue;
                }
                // SFCC imports stores by store-id: a second store with the same ID would overwrite the first.
                if (seenIds[records[0].storeId]) {
                    stats.failed++;
                    if (stats.errors.length < 5) {
                        stats.errors.push(records[0].storeId + ': store ID already used by another store; not exported');
                    }
                    continue;
                }
                seenIds[records[0].storeId] = true;
                stats.warnings += (records[0].issues || []).length;
                writeStore(writer, records[0], stats);
            }
            offset += results.length;
        } while (offset < total && results.length > 0);

        writer.write(xmlBuilder.buildFooter());
        streamWriter.closeWriter(writer);
        writer = null;

        var exportTotal = refSet ? matched : total;
        if (!stats.built) {
            var noneError = keys && keys.length
                ? 'No matching stores found for the selected items.'
                : 'No source stores found.';
            if (stats.online && !stats.failed) {
                noneError = 'No physical stores to export: ' + stats.online
                    + ' selected store(s) are set to Online store (sales channel), which are not SFCC stores.';
            } else if (stats.failed) {
                noneError = 'No store could be exported. ' + stats.errors.join('; ');
            }
            return { ok: false, error: noneError };
        }

        var putResult = uploader.uploadLocalFile(resolved);
        if (!putResult.ok) {
            return { ok: false, error: putResult.error };
        }

        return {
            ok:         true,
            singleFile: true,
            total:      exportTotal,
            nextOffset: exportTotal,
            done:       true,
            built:      stats.built,
            failed:     stats.failed,
            errors:     stats.errors,
            online:     stats.online,
            warnings:   stats.warnings,
            fileName:   resolved,
            runDate:    runDate,
            impexPath:  impexPath,
            exportKey:  exportKey
        };
    } catch (e) {
        if (writer) {
            streamWriter.closeWriter(writer);
        }
        return { ok: false, error: e.message || String(e) };
    }
}

/**
 * @param {number} offset
 * @param {string} exportKey
 * @param {string} [fileName]
 * @param {Array<string>} [keys]
 * @param {boolean} [singleFile]
 * @param {{ types?: Object.<string, string>, idSource?: string }} [options] - see runSingleFile
 * @returns {Object}
 */
function runBatch(offset, exportKey, fileName, keys, singleFile, options) {
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
                impexPath:  fileResolver.getRelativePath(MODULE_KEY)
            };
        }
        return runSingleFile(exportKey, fileName, keys, options);
    }

    if (offset > 0) {
        return {
            ok:         true,
            total:      0,
            nextOffset: offset,
            done:       true,
            built:      0,
            failed:     0,
            errors:     [],
            impexPath:  fileResolver.getRelativePath(MODULE_KEY)
        };
    }

    return runSingleFile(exportKey, fileName, keys, options);
}

module.exports = { runBatch: runBatch };
