'use strict';

var sourceAttrIds    = require('*/cartridge/scripts/migration/core/sourceAttrIds');
var attrIdMapSession = require('*/cartridge/scripts/migration/core/attrIdMapSession');

/**
 * Transform a Shopify address into an SFCC address payload.
 * @param {Object}  addr        - Shopify address object
 * @param {boolean} isPreferred - whether to mark as preferred shipping address
 * @returns {Object|null} SFCC address payload, or null if addr is falsy
 */
function transformAddress(addr, isPreferred) {
    if (!addr) return null;

    var sfccAddr = {
        address_id: addr.id ? String(addr.id) : ('shopify-' + (addr.country_code || '') + '-' + (addr.zip || '0')),
        preferred:  !!isPreferred
    };

    if (addr.first_name) sfccAddr.first_name  = addr.first_name;
    if (addr.last_name)  sfccAddr.last_name    = addr.last_name;
    if (addr.company)    sfccAddr.company_name = addr.company;
    if (addr.address1)   sfccAddr.address1     = addr.address1;
    if (addr.address2)   sfccAddr.address2     = addr.address2;
    if (addr.city)        sfccAddr.city         = addr.city;
    if (addr.zip)          sfccAddr.postal_code  = addr.zip;
    if (addr.country_code) sfccAddr.country_code = addr.country_code;

    // Shopify uses province/province_code for the state/province field
    if (addr.province_code) sfccAddr.state_code = addr.province_code;
    else if (addr.province) sfccAddr.state_code = addr.province;

    if (addr.phone) sfccAddr.phone = addr.phone;

    return sfccAddr;
}

/**
 * Convert a Shopify tags string ("vip, wholesale") into a trimmed array.
 * @param {string} tags
 * @returns {Array<string>}
 */
function parseTags(tags) {
    if (!tags) return [];
    return String(tags).split(',').map(function (t) { return t.trim(); }).filter(Boolean);
}

/**
 * Shopify returns list metafield values as JSON strings. Preserve them as arrays
 * so SFCC set attributes work in both Script API writes and customer IMPEX XML.
 * @param {*} value
 * @param {string} type
 * @returns {*}
 */
function resolveMetafieldValue(value, type) {
    if (String(type || '').indexOf('list.') !== 0 || typeof value !== 'string') return value;
    try {
        var parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : value;
    } catch (e) {
        return value;
    }
}

/**
 * Add Shopify customer metafields as Profile custom attributes.
 * Attribute IDs match the preflight convention: spy_<namespace>__<key>.
 * @param {Object} profile
 * @param {Object[]} metafields
 */
function mapMetafields(profile, metafields) {
    var attrMap = attrIdMapSession.read('customer');
    var list = metafields || [];

    for (var i = 0; i < list.length; i++) {
        var metafield = list[i] || {};
        if (!metafield.key || metafield.value === null || metafield.value === undefined) continue;

        var rawId = metafield.namespace
            ? metafield.namespace + '__' + metafield.key
            : metafield.key;
        var canonicalId = sourceAttrIds.toAttrId(rawId, 'shopify');
        var sfccAttrId = attrIdMapSession.resolve(canonicalId, attrMap);
        profile['c_' + sfccAttrId] = resolveMetafieldValue(metafield.value, metafield.type);
    }
}

/**
 * Transform a Shopify customer record into SFCC customer creation payloads.
 * @param {Object} shopifyCustomer - Shopify customer object (REST Admin API)
 * @returns {{ profile: Object, addresses: Array }}
 *   profile   - customer fields for SFCC customer creation
 *   addresses - array of SFCC address payloads for address migration phase
 */
function transformCustomer(shopifyCustomer) {
    if (!shopifyCustomer || !shopifyCustomer.email) {
        throw new Error('Shopify customer missing required email field (id: ' + (shopifyCustomer && shopifyCustomer.id) + ')');
    }

    var profile = {
        email: shopifyCustomer.email,
        login: shopifyCustomer.email
    };

    if (shopifyCustomer.first_name) profile.first_name = shopifyCustomer.first_name;
    if (shopifyCustomer.last_name)  profile.last_name   = shopifyCustomer.last_name;
    if (shopifyCustomer.locale) profile.preferred_locale = String(shopifyCustomer.locale).replace(/-/g, '_');

    // Keep migration-only identifiers outside c_*; they are not SFCC attributes.
    profile.source_customer_id = String(shopifyCustomer.id);
    // Phone has a native SFCC Profile equivalent (phoneMobile).
    if (shopifyCustomer.phone)             profile.phone                       = shopifyCustomer.phone;
    if (shopifyCustomer.tags) profile.shopify_tags = parseTags(shopifyCustomer.tags);

    mapMetafields(profile, shopifyCustomer.metafields);

    // Transform addresses
    var addresses      = [];
    var shopifyAddrs    = shopifyCustomer.addresses || [];
    var defaultAddrId   = shopifyCustomer.default_address ? shopifyCustomer.default_address.id : null;

    for (var a = 0; a < shopifyAddrs.length; a++) {
        var raw         = shopifyAddrs[a];
        var isPreferred = !!raw.default || (defaultAddrId && defaultAddrId === raw.id);
        var sfccAddr    = transformAddress(raw, isPreferred);
        if (sfccAddr) addresses.push(sfccAddr);
    }

    return { profile: profile, addresses: addresses };
}

module.exports = {
    transformCustomer: transformCustomer,
    transformAddress:  transformAddress,
    parseTags:         parseTags,
    resolveMetafieldValue: resolveMetafieldValue,
    mapMetafields:     mapMetafields
};
