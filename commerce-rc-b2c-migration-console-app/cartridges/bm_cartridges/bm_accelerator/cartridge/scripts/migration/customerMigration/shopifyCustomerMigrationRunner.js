'use strict';

var fetcher      = require('*/cartridge/scripts/migration/customerMigration/shopifyCustomerFetcher');
var transformer  = require('*/cartridge/scripts/migration/customerMigration/shopifyCustomerTransformer');
var writer       = require('*/cartridge/scripts/migration/customerMigration/sfccCustomerWriter');
var groupWriter  = require('*/cartridge/scripts/migration/customerMigration/sfccCustomerGroupWriter');
var groupFetcher = require('*/cartridge/scripts/migration/customerMigration/shopifyCustomerGroupFetcher');

/**
 * Assign a just-created customer to one SFCC group per Shopify tag. Non-fatal:
 * groups may not exist yet if the Fetch/Create Groups step hasn't been run.
 * @param {string} customerNo
 * @param {Array<string>} tags
 */
function assignTagGroups(customerNo, tags) {
    if (!tags || !tags.length) return;
    var groupIds = [];
    for (var i = 0; i < tags.length; i++) groupIds.push(groupFetcher.groupIdForTag(tags[i]));
    try { groupWriter.assignCustomerToGroups(customerNo, groupIds); } catch (ge) { /* non-fatal */ }
}

/**
 * Migrate a single customer profile by Shopify customer ID.
 * Used by the Partial Migration "selected IDs" mode.
 *
 * @param {string} shopifyId - Shopify numeric customer ID
 * @param {string} listId    - SFCC customer list ID
 * @returns {Object} { ok, created, skipped, failed, errors, mappings }
 */
function runProfileBatchById(shopifyId, listId) {
    if (!listId)    return { ok: false, error: 'listId is required' };
    if (!shopifyId) return { ok: false, error: 'shopifyId is required' };

    var shopifyCustomer;
    try {
        shopifyCustomer = fetcher.fetchById(shopifyId.trim());
    } catch (fe) {
        return { ok: true, created: 0, skipped: 0, failed: 1,
                 errors: [shopifyId + ': ' + (fe.message || String(fe))], mappings: [] };
    }
    if (!shopifyCustomer) {
        return { ok: true, created: 0, skipped: 0, failed: 1,
                 errors: [shopifyId + ': customer not found in Shopify'], mappings: [] };
    }

    var transformed;
    try {
        transformed = transformer.transformCustomer(shopifyCustomer);
    } catch (te) {
        return { ok: true, created: 0, skipped: 0, failed: 1,
                 errors: [(shopifyCustomer.email || shopifyId) + ': transform — ' + (te.message || String(te))], mappings: [] };
    }

    var tempPassword = require('*/cartridge/scripts/migration/core/tempPassword').generate();
    var result;
    try {
        result = writer.createCustomer(null, listId, transformed.profile, tempPassword);
    } catch (we) {
        return { ok: true, created: 0, skipped: 0, failed: 1,
                 errors: [(shopifyCustomer.email || shopifyId) + ': ' + (we.message || String(we))], mappings: [] };
    }

    if (result.ok) {
        assignTagGroups(result.customerNo, transformed.profile.shopify_tags);
        return {
            ok: true, created: 1, skipped: 0, failed: 0, errors: [],
            mappings: [{
                ctpId:        shopifyCustomer.id,
                sfccNo:       result.customerNo,
                ctpAddresses: transformed.addresses
            }]
        };
    }
    if (result.skipped) {
        return { ok: true, created: 0, skipped: 1, failed: 0, errors: [], mappings: [] };
    }
    return { ok: true, created: 0, skipped: 0, failed: 1,
             errors: [(shopifyCustomer.email || shopifyId) + ': ' + (result.error || 'unknown')], mappings: [] };
}

module.exports = {
    runProfileBatchById: runProfileBatchById
};
