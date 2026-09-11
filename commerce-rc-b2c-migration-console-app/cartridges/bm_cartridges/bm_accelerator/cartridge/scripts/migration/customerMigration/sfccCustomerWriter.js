'use strict';

/**
 * Create one customer using the SFCC Script API.
 * requires are deferred inside functions so any module-load failure is caught by the
 * runner's per-customer try/catch and returned as JSON instead of an HTML 500 page.
 *
 * @param {string} token    - unused; kept for API compatibility with customerMigrationRunner
 * @param {string} listId   - SFCC customer list ID (e.g. "RefArch")
 * @param {Object} profile  - SFCC customer profile fields from customerTransformer
 * @param {string} password - temporary password
 * @returns {{ ok: boolean, customerNo: string|null, skipped: boolean, error: string|null }}
 */
function createCustomer(token, listId, profile, password) {
    var CustomerMgr = require('dw/customer/CustomerMgr');
    var Transaction = require('dw/system/Transaction');

    var login = profile.login || profile.email;
    /** @type {{ ok: boolean, skipped: boolean, customerNo: string|null, error: string|null }} */
    var result = { ok: false, skipped: false, customerNo: null, error: null };

    try {
        Transaction.begin();

        var list = CustomerMgr.getCustomerList(listId);
        if (!list) {
            Transaction.rollback();
            result.error = 'Customer list not found: ' + listId;
            return result;
        }

        // CustomerMgr.createCustomer(login, pass, customerNo:String) sets a specific number.
        // CustomerMgr.createCustomer(login, pass, list:CustomerList) auto-generates a numeric ID
        // (used when the source system has no native customer number to carry over).
        var sourceNo = profile.customer_no || profile.source_customer_id || null;
        var customer = sourceNo
            ? CustomerMgr.createCustomer(login, password, String(sourceNo))
            : CustomerMgr.createCustomer(login, password, list);
        if (!customer) {
            Transaction.rollback();
            result.error = 'CustomerMgr.createCustomer returned null';
            return result;
        }

        var p = customer.getProfile();
        if (!p) {
            Transaction.rollback();
            result.error = 'Customer profile not found';
            return result;
        }
        if (profile.email)        p.setEmail(profile.email);
        if (profile.first_name)   p.setFirstName(profile.first_name);
        if (profile.last_name)    p.setLastName(profile.last_name);
        if (profile.company_name) p.setCompanyName(profile.company_name);
        if (profile.salutation)   p.setSalutation(profile.salutation);
        if (profile.phone)        p.setPhoneMobile(profile.phone);
        // Restricted/validated fields can throw (permission or invalid-value errors) — must not block customer creation.
        if (profile.second_name) {
            try { p.setSecondName(profile.second_name); } catch (se) { /* ignore */ }
        }
        if (profile.title) {
            try { p.setTitle(profile.title); } catch (tte) { /* ignore */ }
        }
        if (profile.preferred_locale) {
            try { p.setPreferredLocale(profile.preferred_locale); } catch (le) { /* e.g. locale not enabled on site */ }
        }
        if (profile.tax_id) {
            try { p.setTaxID(profile.tax_id); } catch (te) { /* insufficient permission or other write restriction */ }
        }

        if (profile.birthday) {
            try {
                var parts = String(profile.birthday).split('-');
                p.setBirthday(new Date(
                    parseInt(parts[0], 10),
                    parseInt(parts[1], 10) - 1,
                    parseInt(parts[2], 10)
                ));
            } catch (be) { /* ignore unparseable date */ }
        }

        // Write all custom attributes from the transformer output.
        // Keys prefixed with "c_" are custom attribute names (transformer convention).
        // Visit-scoped renames (attrIdMap) are applied so Shopify/CT create-as-rename works.
        var attrIdMapSession = require('*/cartridge/scripts/migration/core/attrIdMapSession');
        var attrMap = attrIdMapSession.read('customer');
        var customKeys = Object.keys(profile);
        for (var ci = 0; ci < customKeys.length; ci++) {
            var ck = customKeys[ci];
            if (ck.length > 2 && ck.charAt(0) === 'c' && ck.charAt(1) === '_') {
                var sfccAttrId = attrIdMapSession.resolve(ck.slice(2), attrMap);
                var attrVal    = profile[ck];
                if (attrVal !== null && attrVal !== undefined) {
                    try { p.custom[sfccAttrId] = attrVal; } catch (ce) { /* attr not defined in SFCC yet */ }
                }
            }
        }

        result.customerNo = String(p.customerNo);
        Transaction.commit();
        result.ok = true;
    } catch (e) {
        try { Transaction.rollback(); } catch (re) { /* ignore rollback errors */ }
        var msg = e.message || String(e);
        var msgLc = msg.toLowerCase();
        // Duplicate login — SFCC throws when login already exists anywhere in the realm
        if (msgLc.indexOf('exist') >= 0 || msgLc.indexOf('duplicate') >= 0 ||
            msgLc.indexOf('login')  >= 0 || msgLc.indexOf('already')   >= 0) {
            return { ok: false, skipped: true, customerNo: null, error: null };
        }
        result.error = msg;
    }

    return result;
}

/**
 * Create or update one address on an SFCC customer using the Script API.
 *
 * @param {string} token      - unused; kept for API compatibility
 * @param {string} listId     - unused; kept for API compatibility
 * @param {string} customerNo - SFCC customer number returned by createCustomer
 * @param {Object} address    - SFCC address object (must include address_id)
 * @returns {{ ok: boolean, error: string }}
 */
function createAddress(token, listId, customerNo, address) {
    var CustomerMgr = require('dw/customer/CustomerMgr');
    var Transaction = require('dw/system/Transaction');

    var result = { ok: false, error: null };

    try {
        Transaction.begin();

        var customer = CustomerMgr.getCustomerByCustomerNumber(customerNo);
        if (!customer) {
            Transaction.rollback();
            result.error = 'Customer not found: ' + customerNo;
            return result;
        }

        var book   = customer.getAddressBook();
        var addrId = address.address_id || 'imported';
        var addr   = book.getAddress(addrId);

        if (!addr) {
            addr = book.createAddress(addrId);
        }

        if (address.first_name)   addr.setFirstName(address.first_name);
        if (address.last_name)    addr.setLastName(address.last_name);
        if (address.title)        addr.setTitle(address.title);
        if (address.salutation)   addr.setSalutation(address.salutation);
        if (address.company_name) addr.setCompanyName(address.company_name);
        if (address.address1)     addr.setAddress1(address.address1);
        if (address.address2)     addr.setAddress2(address.address2);
        if (address.city)         addr.setCity(address.city);
        if (address.postal_code)  addr.setPostalCode(address.postal_code);
        if (address.post_box)     addr.setPostBox(address.post_box);
        if (address.country_code) addr.setCountryCode(address.country_code);
        if (address.state_code)   addr.setStateCode(address.state_code);
        if (address.phone)        addr.setPhone(address.phone);
        if (address.suite)        addr.setSuite(address.suite);

        if (address.preferred) {
            book.setPreferredAddress(addr);
        }

        Transaction.commit();
        result.ok = true;
    } catch (e) {
        try { Transaction.rollback(); } catch (re) { /* ignore */ }
        result.error = e.message || String(e);
    }

    return result;
}

module.exports = { createCustomer: createCustomer, createAddress: createAddress };
