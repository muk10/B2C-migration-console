'use strict';

var File       = require('dw/io/File');
var FileWriter = require('dw/io/FileWriter');
var registry   = require('*/cartridge/scripts/migration/core/dataSourceRegistry');
var connector  = registry.getFetcher('order');
var mapper     = registry.getMapper('order');
var validator  = require('*/cartridge/scripts/migration/orders/validators/orderValidator');
var xmlGen     = require('*/cartridge/scripts/migration/orders/generators/sfccOrderXmlGenerator');
var fileResolver = require('*/cartridge/scripts/migration/core/migrationFileResolver');
var paths      = require('*/cartridge/scripts/migration/core/migrationPaths');
var impexGen   = require('*/cartridge/scripts/migration/orders/generators/impexGenerator');
var productIds = require('*/cartridge/scripts/migration/orders/productIdResolver');

var MODULE_KEY         = 'order';
var PAGE_LIMIT         = connector.DEFAULT_LIMIT;
// One request reads this many orders, then returns its state to the page, which calls again.
// Keeps every Business Manager request short whatever the total.
var ORDERS_PER_REQUEST = 1000;
// A part file is closed and the next one started before it would pass this size. Salesforce
// advises keeping WebDAV downloads under 200 MB; import files themselves have no size limit.
// Counted in characters: order XML is almost all ASCII, and the 10 MB margin covers the rest.
var MAX_FILE_CHARS     = 190 * 1024 * 1024;
var MAX_ERRORS         = 5;
var STEM_PATTERN       = /^[A-Za-z0-9_]+-\d{8}-v\d{3}$/;

/**
 * @param {Object} options
 * @returns {Object}
 */
function buildFetchOptions(options) {
    var years    = connector.parseYears(options.years);
    var maxCount = options.maxCount ? parseInt(String(options.maxCount), 10) : null;
    return {
        years:        years,
        maxCount:     maxCount,
        orderState:   options.orderState || '',
        paymentState: options.paymentState || '',
        sinceDate:    connector.dateYearsAgo(years)
    };
}

/**
 * @param {number} part - 1-based part number
 * @returns {string} e.g. 0001
 */
function padPart(part) {
    var s = String(part);
    while (s.length < 4) s = '0' + s;
    return s;
}

/**
 * @param {string} stem - e.g. order-20260929-v001
 * @param {number} part - 1-based part number
 * @returns {string} e.g. order-20260929-v001-p0001.xml
 */
function partFileName(stem, part) {
    return stem + '-p' + padPart(part) + '.xml';
}

/**
 * First run version for today with no file yet, single-file or split.
 * @param {string} impexPath
 * @param {string} runDate
 * @returns {string} file stem, e.g. order-20260929-v002
 */
function resolveStem(impexPath, runDate) {
    var version;
    for (version = 1; version <= 999; version++) {
        var stem = paths.buildXmlFileName(MODULE_KEY, runDate, version).replace(/\.xml$/, '');
        if (!fileResolver.localFileExists(impexPath + '/' + stem + '.xml')
            && !fileResolver.localFileExists(impexPath + '/' + partFileName(stem, 1))) {
            return stem;
        }
    }
    throw new Error('No free order file version left for ' + runDate);
}

/**
 * Fresh run state: exact total, file stem, empty cursor.
 * @param {Object} fetchOpts
 * @param {string} impexPath
 * @returns {Object}
 */
function startState(fetchOpts, impexPath) {
    var counts  = connector.countOrders(fetchOpts);
    var runDate = fileResolver.getRunDate(MODULE_KEY, 0);
    return {
        total:     counts.exportCount,
        runDate:   runDate,
        stem:      resolveStem(impexPath, runDate),
        part:      0,
        inPart:    0,
        partChars: 0,
        processed: 0,
        validated: 0,
        failed:    0,
        productsNotFound: 0,
        offset:    0,
        after:     null,
        files:     []
    };
}

/**
 * Validate state sent back by the page; only numbers, the cursor and a checked stem are used.
 * @param {Object} s - state from the previous response
 * @returns {Object}
 */
function readState(s) {
    if (!s || !STEM_PATTERN.test(String(s.stem || ''))) {
        throw new Error('Invalid export state');
    }
    var part = parseInt(s.part, 10) || 0;
    var files = [];
    var p;
    for (p = 1; p <= part; p++) files.push(partFileName(s.stem, p));
    return {
        total:     parseInt(s.total, 10) || 0,
        runDate:   String(s.runDate || ''),
        stem:      String(s.stem),
        part:      part,
        inPart:    parseInt(s.inPart, 10) || 0,
        partChars: parseInt(s.partChars, 10) || 0,
        processed: parseInt(s.processed, 10) || 0,
        validated: parseInt(s.validated, 10) || 0,
        failed:    parseInt(s.failed, 10) || 0,
        productsNotFound: parseInt(s.productsNotFound, 10) || 0,
        offset:    parseInt(s.offset, 10) || 0,
        after:     s.after && s.after.createdAt && s.after.id
            ? { createdAt: String(s.after.createdAt), id: String(s.after.id) } : null,
        files:     files
    };
}

/**
 * Open the current part for writing: a new part (with header) when the last one is full,
 * otherwise append to the part left open by the previous request.
 * @param {Object} dir - IMPEX order directory (dw.io.File)
 * @param {Object} state
 * @returns {Object} dw.io.FileWriter
 */
function openPart(dir, state) {
    if (state.inPart === 0) {
        state.part++;
        state.files.push(partFileName(state.stem, state.part));
        var writer = new FileWriter(new File(dir, partFileName(state.stem, state.part)), 'UTF-8');
        var header = xmlGen.buildHeader();
        writer.write(header);
        state.partChars = header.length;
        return writer;
    }
    return new FileWriter(new File(dir, partFileName(state.stem, state.part)), 'UTF-8', true);
}

/**
 * Export the next slice of orders (up to ORDERS_PER_REQUEST) into XML part files.
 * Call first with no state; while the result is not done, call again with result.state.
 * @param {Object} options - { years, maxCount, orderState, paymentState, creds, maxFileChars (tests) }
 * @param {Object} [stateIn] - state from the previous call
 * @returns {Object}
 */
function runChunk(options, stateIn) {
    var fetchOpts = buildFetchOptions(options);
    var impexPath = paths.getRelativePath(MODULE_KEY);
    var writer    = null;
    var errors    = [];

    try {
        var token  = connector.authenticate(options.creds);
        var state  = stateIn ? readState(stateIn) : startState(fetchOpts, impexPath);
        var dir    = impexGen.ensureDir(impexPath);
        var cursor = connector.SUPPORTS_CURSOR === true;
        var max    = fetchOpts.maxCount;
        var maxChars  = options.maxFileChars || MAX_FILE_CHARS;
        var footerLen = xmlGen.buildFooter().length;
        var done   = false;
        var readThisRequest = 0;
        var products = productIds.createResolver();

        while (!done && readThisRequest < ORDERS_PER_REQUEST) {
            var page = connector.fetchOrdersPage(token, {
                years:        fetchOpts.years,
                sinceDate:    fetchOpts.sinceDate,
                orderState:   fetchOpts.orderState,
                paymentState: fetchOpts.paymentState,
                after:        cursor ? state.after : null,
                offset:       state.offset,
                limit:        PAGE_LIMIT,
                withTotal:    false
            });
            var results = page.results || [];
            var i;
            if (connector.addCustomerNumbers) connector.addCustomerNumbers(token, results);

            for (i = 0; i < results.length; i++) {
                if (max && state.processed >= max) break;
                var raw = results[i];
                state.processed++;
                state.offset++;
                readThisRequest++;
                if (cursor) state.after = { createdAt: raw.createdAt, id: raw.id };

                try {
                    var canonical = mapper.mapOrder(raw);
                    state.productsNotFound += products.resolveOrder(canonical);
                    var vResult   = validator.validateOrder(canonical);
                    if (!vResult.valid) {
                        state.failed++;
                        if (errors.length < MAX_ERRORS) {
                            errors.push((canonical.orderNumber || '?') + ': ' + vResult.errors.join('; '));
                        }
                        continue;
                    }
                    var inner = xmlGen.generateOrderInnerXml(canonical);
                    xmlGen.assertValidOrderDocument(inner);

                    // quota: close the current part if this order would push it past the size limit
                    if (state.inPart > 0 && state.partChars + inner.length + 1 + footerLen > maxChars) {
                        if (!writer) writer = openPart(dir, state);
                        writer.write(xmlGen.buildFooter());
                        writer.close();
                        writer = null;
                        state.inPart = 0;
                    }
                    if (!writer) writer = openPart(dir, state);
                    writer.write(inner);
                    writer.write('\n');
                    state.partChars += inner.length + 1;
                    state.inPart++;
                    state.validated++;
                } catch (e) {
                    state.failed++;
                    if (errors.length < MAX_ERRORS) {
                        errors.push((raw.orderNumber || raw.id || 'order') + ': ' + (e.message || String(e)));
                    }
                }
            }

            if (results.length < PAGE_LIMIT || (max && state.processed >= max)) {
                done = true;
            }
        }

        if (done && state.inPart > 0) {
            if (!writer) writer = openPart(dir, state);
            writer.write(xmlGen.buildFooter());
            state.inPart = 0;
        }
        if (writer) {
            writer.close();
            writer = null;
        }

        return {
            ok:                true,
            done:              done,
            total:             Math.max(state.total, state.processed),
            processed:         state.processed,
            ordersProcessed:   state.processed,
            ordersValidated:   state.validated,
            ordersFailed:      state.failed,
            built:             state.validated,
            failed:            state.failed,
            productsNotFound:  state.productsNotFound,
            errors:            errors,
            files:             state.files,
            xmlFilesGenerated: state.files.length,
            fileName:          state.files.join(', '),
            runId:             state.runDate,
            runDate:           state.runDate,
            impexPath:         impexPath,
            state:             done ? null : state
        };
    } catch (e) {
        if (writer) {
            try { writer.close(); } catch (ce) { /* ignore */ }
        }
        return { ok: false, error: e.message || String(e) };
    }
}

module.exports = {
    PAGE_LIMIT:         PAGE_LIMIT,
    ORDERS_PER_REQUEST: ORDERS_PER_REQUEST,
    MAX_FILE_CHARS:     MAX_FILE_CHARS,
    partFileName:       partFileName,
    runChunk:           runChunk
};
