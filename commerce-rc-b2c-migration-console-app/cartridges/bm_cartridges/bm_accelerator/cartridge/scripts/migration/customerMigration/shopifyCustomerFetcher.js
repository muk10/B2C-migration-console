'use strict';

var http      = require('*/cartridge/scripts/migration/core/http');
var connector = require('*/cartridge/scripts/migration/connectors/shopify/shopifyConnector');
var shopifyApi = require('*/cartridge/scripts/migration/core/shopifyApi');
var cfg       = require('*/cartridge/scripts/migration/configAccessor');

var MAX_PAGE_SIZE = 250;
var METAFIELD_BATCH_SIZE = 50;

var CUSTOMER_METAFIELDS_QUERY = [
    'query CustomerMetafields($ids: [ID!]!) {',
    '  nodes(ids: $ids) {',
    '    ... on Customer {',
    '      id',
    '      metafields(first: 250) {',
    '        nodes { id namespace key type value }',
    '      }',
    '    }',
    '  }',
    '}'
].join('\n');

/**
 * Attach Shopify customer metafield values to REST customer records.
 * @param {Object[]} customers Shopify REST customers.
 * @returns {Object[]} Enriched customers.
 */
function enrichCustomersWithMetafields(customers) {
    var list = customers || [];
    var byGid = {};
    var ids = [];
    var i;

    for (i = 0; i < list.length; i++) {
        var gid = list[i] && list[i].admin_graphql_api_id;
        if (gid) {
            byGid[gid] = list[i];
            ids.push(gid);
            list[i].metafields = [];
        }
    }

    for (i = 0; i < ids.length; i += METAFIELD_BATCH_SIZE) {
        var data = shopifyApi.graphql(CUSTOMER_METAFIELDS_QUERY, {
            ids: ids.slice(i, i + METAFIELD_BATCH_SIZE)
        }, cfg.shopify);
        var nodes = data && data.nodes ? data.nodes : [];
        for (var ni = 0; ni < nodes.length; ni++) {
            var node = nodes[ni];
            if (node && node.id && byGid[node.id]) {
                byGid[node.id].metafields = node.metafields && node.metafields.nodes
                    ? node.metafields.nodes
                    : [];
            }
        }
    }

    return list;
}

/**
 * Parse the Shopify Link response header for the "next" page cursor.
 * Format: <https://store/admin/api/2025-01/customers.json?limit=250&page_info=xyz>; rel="next"
 * @param {string} linkHeader
 * @returns {string|null}
 */
function parseNextPageInfo(linkHeader) {
    if (!linkHeader) return null;
    var parts = String(linkHeader).split(',');
    for (var i = 0; i < parts.length; i++) {
        if (parts[i].indexOf('rel="next"') === -1) continue;
        var match = parts[i].match(/page_info=([^&>]+)/);
        return match ? match[1] : null;
    }
    return null;
}

/**
 * @returns {number} total customer count in the connected Shopify store
 */
function getCount() {
    var c   = cfg.shopify;
    var res = http.get(connector.getAdminBase(c) + '/customers/count.json', connector.getAuthHeaders(c));
    if (res.status !== 200) {
        throw new Error('Shopify customer count failed (' + res.status + ')');
    }
    return res.data.count || 0;
}

/**
 * Fetch one page of customers using Shopify's cursor-based pagination.
 * @param {string|null} pageInfo - cursor from a previous page's "next" link, or null for the first page
 * @param {number} [limit] - page size (max 250)
 * @returns {{ results: Array, nextPageInfo: string|null }}
 */
function fetchPage(pageInfo, limit) {
    var c  = cfg.shopify;
    var qs = '?limit=' + (limit || MAX_PAGE_SIZE);
    if (pageInfo) {
        qs += '&page_info=' + encodeURIComponent(pageInfo);
    }
    var res = http.get(connector.getAdminBase(c) + '/customers.json' + qs, connector.getAuthHeaders(c));
    if (res.status !== 200) {
        throw new Error('Shopify customers fetch failed (' + res.status + ')');
    }
    return {
        results:      enrichCustomersWithMetafields(res.data.customers || []),
        nextPageInfo: parseNextPageInfo(res.link)
    };
}

/**
 * Fetch a single customer from Shopify by their numeric ID.
 * @param {string|number} shopifyId
 * @returns {Object|null} Shopify customer object, or null if not found (404)
 */
function fetchById(shopifyId) {
    var c    = cfg.shopify;
    var id   = String(shopifyId || '').trim();
    var res  = http.get(connector.getAdminBase(c) + '/customers/' + encodeURIComponent(id) + '.json', connector.getAuthHeaders(c));
    if (res.status === 404) return null;
    if (res.status !== 200) {
        throw new Error('Shopify customer fetch failed (' + res.status + ') for id: ' + id);
    }
    var customer = res.data.customer || null;
    return customer ? enrichCustomersWithMetafields([customer])[0] : null;
}

module.exports = {
    getCount:                       getCount,
    fetchPage:                      fetchPage,
    fetchById:                      fetchById,
    enrichCustomersWithMetafields: enrichCustomersWithMetafields,
    METAFIELD_BATCH_SIZE:           METAFIELD_BATCH_SIZE
};
