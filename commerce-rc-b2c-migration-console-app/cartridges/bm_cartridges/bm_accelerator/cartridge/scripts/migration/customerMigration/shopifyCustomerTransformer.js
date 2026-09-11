'use strict';

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

    // Store Shopify identifiers/fields as custom attributes for traceability
    profile.c_shopify_customer_id = String(shopifyCustomer.id);
    // Phone has a native SFCC Profile equivalent (phoneMobile) — no shadow custom attribute needed.
    if (shopifyCustomer.phone) {
        profile.phone = shopifyCustomer.phone;
        profile.phone_mobile = shopifyCustomer.phone;
    }
    if (shopifyCustomer.note)              profile.c_shopify_note              = shopifyCustomer.note;
    if (shopifyCustomer.tags)              profile.c_shopify_tags              = parseTags(shopifyCustomer.tags);
    if (shopifyCustomer.verified_email !== undefined)    profile.c_shopify_verified_email    = shopifyCustomer.verified_email;
    if (shopifyCustomer.accepts_marketing !== undefined) profile.c_shopify_accepts_marketing = shopifyCustomer.accepts_marketing;
    if (shopifyCustomer.orders_count !== undefined)      profile.c_shopify_orders_count      = shopifyCustomer.orders_count;
    if (shopifyCustomer.total_spent !== undefined)       profile.c_shopify_total_spent       = shopifyCustomer.total_spent;

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

module.exports = { transformCustomer: transformCustomer, transformAddress: transformAddress, parseTags: parseTags };
