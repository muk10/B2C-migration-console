'use strict';

/**
 * Transform a BigCommerce address into an SFCC address payload.
 * @param {Object}  addr        - BigCommerce V3 customer address object
 * @param {boolean} isPreferred - whether to mark as preferred shipping address
 * @returns {Object|null}
 */
function transformAddress(addr, isPreferred) {
    if (!addr) return null;

    var sfccAddr = {
        address_id: addr.id ? String(addr.id) : ('bc-' + (addr.country_code || '') + '-' + (addr.postal_code || '0')),
        preferred:  !!isPreferred
    };

    if (addr.first_name) sfccAddr.first_name  = addr.first_name;
    if (addr.last_name)  sfccAddr.last_name    = addr.last_name;
    if (addr.company)    sfccAddr.company_name = addr.company;
    if (addr.address1)   sfccAddr.address1     = addr.address1;
    if (addr.address2)   sfccAddr.address2     = addr.address2;
    if (addr.city)       sfccAddr.city         = addr.city;
    if (addr.postal_code) sfccAddr.postal_code  = addr.postal_code;
    if (addr.country_code) sfccAddr.country_code = addr.country_code;

    if (addr.state_or_province) sfccAddr.state_code = addr.state_or_province;

    if (addr.phone) sfccAddr.phone = addr.phone;

    return sfccAddr;
}

/**
 * Transform a BigCommerce customer record into SFCC customer creation payloads.
 * @param {Object} bcCustomer - BigCommerce V3 customer (optionally with addresses[])
 * @returns {{ profile: Object, addresses: Array }}
 */
function transformCustomer(bcCustomer) {
    if (!bcCustomer || !bcCustomer.email) {
        throw new Error('BigCommerce customer missing required email field (id: ' + (bcCustomer && bcCustomer.id) + ')');
    }

    var profile = {
        email: bcCustomer.email,
        login: bcCustomer.email
    };

    if (bcCustomer.first_name) profile.first_name = bcCustomer.first_name;
    if (bcCustomer.last_name)  profile.last_name  = bcCustomer.last_name;

    // Store BigCommerce identifiers/fields as custom attributes for traceability
    profile.c_bc_customer_id = String(bcCustomer.id);
    if (bcCustomer.phone) {
        profile.phone = bcCustomer.phone;
        profile.phone_mobile = bcCustomer.phone;
    }
    if (bcCustomer.company) profile.c_bc_company = bcCustomer.company;
    if (bcCustomer.notes)   profile.c_bc_notes   = bcCustomer.notes;
    if (bcCustomer.customer_group_id != null) {
        profile.c_bc_customer_group_id = String(bcCustomer.customer_group_id);
    }
    if (bcCustomer.tax_exempt_category) {
        profile.c_bc_tax_exempt_category = bcCustomer.tax_exempt_category;
    }
    if (bcCustomer.accepts_product_review_abandoned_cart_emails !== undefined) {
        profile.c_bc_accepts_marketing = !!bcCustomer.accepts_product_review_abandoned_cart_emails;
    }

    var addresses = [];
    var bcAddrs   = bcCustomer.addresses || [];
    for (var a = 0; a < bcAddrs.length; a++) {
        // First address is preferred when none is explicitly marked
        var sfccAddr = transformAddress(bcAddrs[a], a === 0);
        if (sfccAddr) addresses.push(sfccAddr);
    }

    return { profile: profile, addresses: addresses };
}

module.exports = {
    transformCustomer: transformCustomer,
    transformAddress:  transformAddress
};
