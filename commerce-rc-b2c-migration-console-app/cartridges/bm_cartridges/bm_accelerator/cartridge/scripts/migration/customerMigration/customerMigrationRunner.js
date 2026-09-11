'use strict';

/* global session */

var fetcher     = require('*/cartridge/scripts/migration/customerMigration/ctpCustomerFetcher');
var transformer = require('*/cartridge/scripts/migration/customerMigration/customerTransformer');
var writer      = require('*/cartridge/scripts/migration/customerMigration/sfccCustomerWriter');

var SK_LIVE_LAST_ID = 'migCustLiveLastId';
var SK_LIVE_TOTAL   = 'migCustLiveTotal';

/**
 * Migrate one batch of customer profiles (no addresses — those run separately in phase 2).
 *
 * HTTP budget per call:
 *   1  CT auth  (inside fetchPage)
 *   1  CT GET /customers  (keyset, never offset)
 *   1  createCustomer (batch size capped at 1 — CustomerMgr.createCustomer quota is 2/request)
 *
 * @param {number} offset - processed count from the UI (0 resets the cursor)
 * @param {string} listId - SFCC customer list ID (e.g. "RefArch")
 * @param {string} [lastId] - CT keyset cursor from the previous page
 * @returns {Object} { ok, total, nextOffset, nextLastId, created, skipped, failed, done, errors, mappings }
 *   mappings: [{ ctpId, sfccNo, ctpAddresses, defaultShippingId }] — used by the address phase
 */
function runProfileBatch(offset, listId, lastId) {
    if (!listId) return { ok: false, error: 'listId is required' };

    var cursor = '';
    if (!offset) {
        session.custom[SK_LIVE_LAST_ID] = '';
        session.custom[SK_LIVE_TOTAL]   = '';
        cursor = '';
    } else {
        cursor = lastId || session.custom[SK_LIVE_LAST_ID] || '';
    }

    var batch     = fetcher.fetchPage({ limit: 1, lastId: cursor, withTotal: !cursor });
    var customers = batch.results;
    var total     = batch.total || parseInt(String(session.custom[SK_LIVE_TOTAL] || 0), 10) || 0;
    if (total) session.custom[SK_LIVE_TOTAL] = String(total);

    var created  = 0;
    var skipped  = 0;
    var failed   = 0;
    var errors   = [];
    var mappings = [];

    for (var i = 0; i < customers.length; i++) {
        var ctpCustomer = customers[i];
        var transformed;

        try {
            transformed = transformer.transformCustomer(ctpCustomer);
        } catch (te) {
            failed++;
            if (errors.length < 5) {
                errors.push((ctpCustomer.email || ctpCustomer.id) + ': transform — ' + (te.message || String(te)));
            }
            continue;
        }

        // Prefix ensures the password meets common SFCC policies (uppercase, number, special char).
        // The UUID suffix makes it unique and unguessable. Customers must reset via Forgot Password.
        var tempPassword = require('*/cartridge/scripts/migration/core/tempPassword').generate();
        var result;
        try {
            result = writer.createCustomer(null, listId, transformed.profile, tempPassword);
        } catch (we) {
            failed++;
            if (errors.length < 5) {
                errors.push((ctpCustomer.email || ctpCustomer.id) + ': ' + (we.message || String(we)));
            }
            continue;
        }

        if (result.ok) {
            created++;
            mappings.push({
                ctpId:             ctpCustomer.id,
                sfccNo:            result.customerNo,
                ctpAddresses:      transformed.addresses,
                defaultShippingId: ctpCustomer.defaultShippingAddressId || null
            });
        } else if (result.skipped) {
            skipped++;
        } else {
            failed++;
            if (errors.length < 5) {
                errors.push((ctpCustomer.email || ctpCustomer.id) + ': ' + (result.error || 'unknown'));
            }
        }
    }

    var nextLastId = lastIdFromCustomers(customers) || cursor;
    if (nextLastId) {
        session.custom[SK_LIVE_LAST_ID] = nextLastId;
    }
    var nextOffset = (offset || 0) + customers.length;
    return {
        ok:         true,
        total:      total,
        nextOffset: nextOffset,
        nextLastId: nextLastId,
        created:    created,
        skipped:    skipped,
        failed:     failed,
        done:       customers.length === 0,
        errors:     errors,
        mappings:   mappings
    };
}

function lastIdFromCustomers(customers) {
    if (!customers || !customers.length) return '';
    var last = customers[customers.length - 1];
    return last && last.id ? String(last.id) : '';
}

/**
 * Migrate one batch of addresses for a single already-created customer.
 *
 * HTTP budget per call:
 *   1  getSFCCToken
 *   10 createAddress (max batch size)
 *   ─────────────────
 *   11 total
 *
 * @param {string} sfccCustomerNo - SFCC customer_no returned by runProfileBatch
 * @param {Array}  ctpAddresses   - pre-transformed SFCC address objects from customerTransformer
 * @param {string} listId         - SFCC customer list ID
 * @param {number} offset         - address array slice offset (for pagination within one customer)
 * @returns {Object} { ok, total, nextOffset, created, failed, done, errors }
 */
function runAddressBatch(sfccCustomerNo, ctpAddresses, listId, offset) {
    if (!listId)         return { ok: false, error: 'listId is required' };
    if (!sfccCustomerNo) return { ok: false, error: 'sfccCustomerNo is required' };

    var addresses  = ctpAddresses || [];
    var start      = offset || 0;
    var batch      = addresses.slice(start, start + 10);
    var created    = 0;
    var failed     = 0;
    var errors     = [];

    for (var i = 0; i < batch.length; i++) {
        var result = writer.createAddress(null, listId, sfccCustomerNo, batch[i]);
        if (result.ok) {
            created++;
        } else {
            failed++;
            if (errors.length < 3) {
                errors.push((batch[i].address_id || i) + ': ' + (result.error || 'unknown'));
            }
        }
    }

    var nextOffset = start + batch.length;
    return {
        ok:         true,
        total:      addresses.length,
        nextOffset: nextOffset,
        created:    created,
        failed:     failed,
        done:       nextOffset >= addresses.length || batch.length === 0,
        errors:     errors
    };
}

/**
 * Migrate a single customer profile by CT customer ID.
 * Used by the Partial Migration "selected IDs" mode.
 *
 * @param {string} ctpId  - CT customer UUID
 * @param {string} listId - SFCC customer list ID
 * @returns {Object} { ok, created, skipped, failed, errors, mappings }
 */
function runProfileBatchById(ctpId, listId) {
    if (!listId) return { ok: false, error: 'listId is required' };
    if (!ctpId)  return { ok: false, error: 'ctpId is required' };

    var ctpCustomer;
    try {
        ctpCustomer = fetcher.fetchById(ctpId.trim());
    } catch (fe) {
        return { ok: true, created: 0, skipped: 0, failed: 1,
                 errors: [ctpId + ': ' + (fe.message || String(fe))], mappings: [] };
    }
    if (!ctpCustomer) {
        return { ok: true, created: 0, skipped: 0, failed: 1,
                 errors: [ctpId + ': customer not found in CT'], mappings: [] };
    }

    var transformed;
    try {
        transformed = transformer.transformCustomer(ctpCustomer);
    } catch (te) {
        return { ok: true, created: 0, skipped: 0, failed: 1,
                 errors: [(ctpCustomer.email || ctpId) + ': transform — ' + (te.message || String(te))], mappings: [] };
    }

    var tempPassword = require('*/cartridge/scripts/migration/core/tempPassword').generate();
    var result;
    try {
        result = writer.createCustomer(null, listId, transformed.profile, tempPassword);
    } catch (we) {
        return { ok: true, created: 0, skipped: 0, failed: 1,
                 errors: [(ctpCustomer.email || ctpId) + ': ' + (we.message || String(we))], mappings: [] };
    }

    if (result.ok) {
        return {
            ok: true, created: 1, skipped: 0, failed: 0, errors: [],
            mappings: [{
                ctpId:             ctpCustomer.id,
                sfccNo:            result.customerNo,
                ctpAddresses:      transformed.addresses,
                defaultShippingId: ctpCustomer.defaultShippingAddressId || null
            }]
        };
    }
    if (result.skipped) {
        return { ok: true, created: 0, skipped: 1, failed: 0, errors: [], mappings: [] };
    }
    return { ok: true, created: 0, skipped: 0, failed: 1,
             errors: [(ctpCustomer.email || ctpId) + ': ' + (result.error || 'unknown')], mappings: [] };
}

module.exports = {
    runProfileBatch:     runProfileBatch,
    runProfileBatchById: runProfileBatchById,
    runAddressBatch:     runAddressBatch
};
