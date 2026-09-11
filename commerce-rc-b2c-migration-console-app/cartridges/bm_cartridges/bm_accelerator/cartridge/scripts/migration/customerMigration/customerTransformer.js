'use strict';

var customerSystem = require('*/cartridge/scripts/migration/customerMigration/customerSystemProfile');

/**
 * Transform a CT address into an SFCC address payload.
 * CT: streetName → SFCC address1
 * @param {Object}  addr        - CT address object
 * @param {boolean} isPreferred - whether to mark as preferred shipping address
 * @returns {Object|null} SFCC address payload, or null if addr is falsy
 */
function transformAddress(addr, isPreferred) {
    if (!addr) return null;

    var sfccAddr = {
        address_id: addr.id || addr.key || ('ctp-' + addr.country + '-' + (addr.postalCode || '0')),
        preferred:  !!isPreferred
    };

    if (addr.firstName)   sfccAddr.first_name   = addr.firstName;
    if (addr.lastName)    sfccAddr.last_name     = addr.lastName;
    if (addr.title)       sfccAddr.title         = addr.title;
    if (addr.salutation)  sfccAddr.salutation    = addr.salutation;
    if (addr.company)     sfccAddr.company_name  = addr.company;

    // Per nativeFieldMap.json: streetName -> address1
    if (addr.streetName) sfccAddr.address1 = addr.streetName;

    if (addr.additionalStreetInfo) sfccAddr.address2 = addr.additionalStreetInfo;
    if (addr.city)       sfccAddr.city        = addr.city;
    if (addr.postalCode) sfccAddr.postal_code = addr.postalCode;
    if (addr.country)    sfccAddr.country_code = addr.country;

    // CT uses region or state for the state/province field
    if (addr.state)  sfccAddr.state_code = addr.state;
    if (addr.region && !sfccAddr.state_code) sfccAddr.state_code = addr.region;

    if (addr.phone)  sfccAddr.phone = addr.phone;
    if (addr.mobile && !sfccAddr.phone) sfccAddr.phone = addr.mobile;

    if (addr.pOBox)     sfccAddr.post_box = addr.pOBox;
    if (addr.apartment) sfccAddr.suite    = addr.apartment;

    return sfccAddr;
}

/**
 * Resolve a raw CT custom-field value to a plain scalar for an SFCC custom attribute.
 * LocalizedString/LocalizedEnum values arrive as { "en-GB": "...", "en-US": "..." } —
 * pick the customer's own locale, falling back to the first available language.
 * Set (array) values are joined into a single delimited string.
 * @param {*} val - raw CT custom field value
 * @param {string} [locale] - CT customer locale (e.g. "en-GB")
 * @returns {*} scalar value suitable for an SFCC custom attribute
 */
function resolveCustomFieldValue(val, locale) {
    if (val === null || typeof val !== 'object') return val;
    if (Array.isArray(val)) {
        return val.map(function (v) { return resolveCustomFieldValue(v, locale); }).join(', ');
    }
    if (locale && val[locale] !== undefined) return val[locale];
    var keys = Object.keys(val);
    return keys.length ? val[keys[0]] : '';
}

/**
 * Transform a CT customer record into SFCC customer creation payloads.
 * @param {Object} ctpCustomer - CT customer object
 * @returns {{ profile: Object, addresses: Array }}
 *   profile   - customer fields for SFCC POST /customer_lists/{id}/customers
 *   addresses - array of SFCC address payloads for address migration phase
 */
function transformCustomer(ctpCustomer) {
    if (!ctpCustomer || !ctpCustomer.email) {
        throw new Error('CT customer missing required email field (id: ' + (ctpCustomer && ctpCustomer.id) + ')');
    }

    var profile = {
        email: ctpCustomer.email,
        login: ctpCustomer.email
    };

    if (ctpCustomer.firstName)   profile.first_name   = ctpCustomer.firstName;
    if (ctpCustomer.lastName)    profile.last_name     = ctpCustomer.lastName;
    if (ctpCustomer.companyName) profile.company_name  = ctpCustomer.companyName;
    if (ctpCustomer.dateOfBirth) profile.birthday      = ctpCustomer.dateOfBirth;

    // salutation and title are independent native SFCC fields
    if (ctpCustomer.salutation) profile.salutation = ctpCustomer.salutation;
    if (ctpCustomer.title)      profile.title       = ctpCustomer.title;

    // customerNumber maps to the native SFCC customerNo (per nativeFieldMap.json)
    if (ctpCustomer.customerNumber) profile.customer_no = ctpCustomer.customerNumber;

    // CT built-in fields with a native SFCC Profile equivalent
    if (ctpCustomer.vatId)      profile.tax_id          = ctpCustomer.vatId;
    // CT locale is a hyphenated BCP-47 tag (e.g. "en-GB"); SFCC Locale IDs use an underscore (e.g. "en_GB").
    if (ctpCustomer.locale)     profile.preferred_locale = ctpCustomer.locale.replace(/-/g, '_');
    if (ctpCustomer.middleName) profile.second_name     = ctpCustomer.middleName;

    // Map CT custom fields → SFCC custom attributes (requires matching attr definitions in SFCC)
    if (ctpCustomer.custom && ctpCustomer.custom.fields) {
        var attrIdMapSession = require('*/cartridge/scripts/migration/core/attrIdMapSession');
        var attrMap = attrIdMapSession.read('customer');
        var fields = ctpCustomer.custom.fields;
        var keys   = Object.keys(fields);
        for (var i = 0; i < keys.length; i++) {
            var val = fields[keys[i]];
            if (val !== null && val !== undefined) {
                // Keep the source field id on c_* so XML generation can apply
                // visit-scoped maps (OOTB or custom) at write time.
                var sourceId = keys[i];
                var targetId = attrIdMapSession.resolve(sourceId, attrMap);
                var destKey = customerSystem.profileKey(targetId);
                var resolved = resolveCustomFieldValue(val, ctpCustomer.locale);
                profile['c_' + sourceId] = resolved;
                if (destKey && (profile[destKey] == null || profile[destKey] === '')) {
                    profile[destKey] = resolved;
                }
            }
        }
    }

    // Transform addresses
    var addresses     = [];
    var ctpAddresses  = ctpCustomer.addresses || [];
    var defaultShipId = ctpCustomer.defaultShippingAddressId;

    for (var a = 0; a < ctpAddresses.length; a++) {
        var isPreferred = defaultShipId && defaultShipId === ctpAddresses[a].id;
        var sfccAddr    = transformAddress(ctpAddresses[a], isPreferred);
        if (sfccAddr) addresses.push(sfccAddr);
    }

    return { profile: profile, addresses: addresses };
}

module.exports = { transformCustomer: transformCustomer, transformAddress: transformAddress };
