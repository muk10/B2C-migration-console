'use strict';

var transformer = require('*/cartridge/scripts/migration/customerMigration/customerTransformer');
var customerSystem = require('*/cartridge/scripts/migration/customerMigration/customerSystemProfile');

function xmlEsc(val) {
    if (val === null || val === undefined) return '';
    return String(val)
        .replace(/&/g,  '&amp;')
        .replace(/</g,  '&lt;')
        .replace(/>/g,  '&gt;')
        .replace(/"/g,  '&quot;')
        .replace(/'/g,  '&apos;');
}

function optEl(indent, tag, val, maxLen) {
    if (val === null || val === undefined || val === '') return '';
    var s = String(val);
    if (maxLen && s.length > maxLen) s = s.substring(0, maxLen);
    return indent + '<' + tag + '>' + xmlEsc(s) + '</' + tag + '>\n';
}

/** customer.xsd birthday is xsd:date (YYYY-MM-DD). */
function toXsdDate(val) {
    if (!val) return '';
    var s = String(val);
    var m = s.match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : '';
}

function buildAddressXml(addr) {
    var preferred = addr.preferred ? 'true' : 'false';
    var i = '            ';
    var xml = '        <address address-id="' + xmlEsc(addr.address_id) + '" preferred="' + preferred + '">\n';
    // customer.xsd complexType.Address sequence
    xml += optEl(i, 'salutation', addr.salutation);
    xml += optEl(i, 'title', addr.title);
    xml += optEl(i, 'first-name', addr.first_name);
    xml += optEl(i, 'second-name', addr.second_name);
    xml += optEl(i, 'last-name', addr.last_name);
    xml += optEl(i, 'suffix', addr.suffix);
    xml += optEl(i, 'company-name', addr.company_name);
    xml += optEl(i, 'job-title', addr.job_title);
    xml += optEl(i, 'address1', addr.address1);
    xml += optEl(i, 'address2', addr.address2);
    xml += optEl(i, 'suite', addr.suite, 32);
    xml += optEl(i, 'postbox', addr.post_box || addr.postbox);
    xml += optEl(i, 'city', addr.city);
    xml += optEl(i, 'postal-code', addr.postal_code, 10);
    xml += optEl(i, 'state-code', addr.state_code);
    xml += optEl(i, 'country-code', addr.country_code, 2);
    xml += optEl(i, 'phone', addr.phone, 32);
    xml += '        </address>\n';
    return xml;
}

/**
 * Profile XML in customer.xsd order. Runtime Check Attributes maps (session)
 * send each c_<source> field to an OOTB profile element or a custom-attribute.
 * @param {Object} profile
 * @param {Object.<string, string>} [attrMap]
 * @returns {string}
 */
function buildProfileXml(profile, attrMap) {
    profile = profile || {};
    var mapped = customerSystem.applyRuntimeMaps(profile, attrMap);
    customerSystem.mergeMappedSystem(profile, mapped);

    function sysOr(key) {
        return profile[key];
    }

    var p = '            ';
    var xml = '        <profile>\n';
    xml += optEl(p, 'salutation', sysOr('salutation'));
    xml += optEl(p, 'title', sysOr('title'));
    xml += optEl(p, 'first-name', sysOr('first_name'));
    xml += optEl(p, 'second-name', sysOr('second_name'));
    xml += optEl(p, 'last-name', sysOr('last_name'));
    xml += optEl(p, 'suffix', sysOr('suffix'));
    xml += optEl(p, 'company-name', sysOr('company_name'));
    xml += optEl(p, 'job-title', sysOr('job_title'));
    xml += optEl(p, 'email', sysOr('email'));
    xml += optEl(p, 'phone-home', sysOr('phone_home'), 32);
    xml += optEl(p, 'phone-business', sysOr('phone_business'), 32);
    xml += optEl(p, 'phone-mobile', sysOr('phone_mobile'), 32);
    xml += optEl(p, 'fax', sysOr('fax'), 32);
    xml += optEl(p, 'birthday', toXsdDate(sysOr('birthday')));
    if (sysOr('gender') != null && sysOr('gender') !== '') {
        xml += optEl(p, 'gender', sysOr('gender'));
    }
    xml += optEl(p, 'creation-date', customerSystem.formatImpexDateTime(sysOr('creation_date')));
    xml += optEl(p, 'last-login-time', customerSystem.formatImpexDateTime(sysOr('last_login_time')));
    xml += optEl(p, 'last-visit-time', customerSystem.formatImpexDateTime(sysOr('last_visit_time')));
    xml += optEl(p, 'preferred-locale', sysOr('preferred_locale'), 10);

    var customAttrXml = '';
    var ci;
    for (ci = 0; ci < (mapped.custom || []).length; ci++) {
        var ca = mapped.custom[ci];
        if (!ca || !ca.id || ca.value === '' || ca.value == null) continue;
        if (customerSystem.isNonCustomSystemField(ca.id)) continue;
        customAttrXml += '                <custom-attribute attribute-id="' + xmlEsc(ca.id) + '">'
            + xmlEsc(customerSystem.formatCustomAttrValue(ca.value)) + '</custom-attribute>\n';
    }
    if (customAttrXml) {
        xml += '            <custom-attributes>\n' + customAttrXml + '            </custom-attributes>\n';
    }
    xml += '        </profile>\n';
    return xml;
}

function buildCustomerXml(ctpCustomer) {
    var transformed = transformer.transformCustomer(ctpCustomer);
    var profile     = transformed.profile;
    var addresses   = transformed.addresses;

    // customer-no is required by the IMPEX schema and can't be blank — prefer CT's own
    // customerNumber (matches sfccCustomerWriter.js), fall back to CT id if it's not set.
    var customerNo = profile.customer_no || String(ctpCustomer.id);
    var password   = require('*/cartridge/scripts/migration/core/tempPassword').generate();
    var login      = xmlEsc(profile.login || profile.email);

    var xml = '    <customer customer-no="' + xmlEsc(customerNo) + '">\n';

    xml += '        <credentials>\n';
    xml += '            <login>' + login + '</login>\n';
    xml += '            <password encrypted="false">' + xmlEsc(password) + '</password>\n';
    xml += '        </credentials>\n';

    xml += buildProfileXml(profile);

    if (addresses.length > 0) {
        xml += '        <addresses>\n';
        for (var a = 0; a < addresses.length; a++) {
            xml += buildAddressXml(addresses[a]);
        }
        xml += '        </addresses>\n';
    }

    // Include customer group assignment — CT group UUID used directly as SFCC group ID
    if (ctpCustomer.customerGroup && ctpCustomer.customerGroup.id) {
        xml += '        <customer-groups>\n';
        xml += '            <customer-group group-id="' + xmlEsc(ctpCustomer.customerGroup.id) + '"/>\n';
        xml += '        </customer-groups>\n';
    }

    xml += '    </customer>\n';
    return xml;
}

var XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>\n'
               + '<customers xmlns="http://www.demandware.com/xml/impex/customer/2006-10-31">\n';
var XML_FOOTER = '</customers>\n';

/**
 * Build just the <customer> element(s) for a batch — no XML header/root wrapper.
 * Used so multiple batches can be concatenated into a single IMPEX file.
 * @param {Array} ctpCustomers - raw CT customer objects from ctpCustomerFetcher
 * @returns {{ body: string, built: number, failed: number, errors: Array }}
 */
function buildCustomerFragment(ctpCustomers) {
    var built  = 0;
    var failed = 0;
    var errors = [];
    var body   = '';

    for (var i = 0; i < ctpCustomers.length; i++) {
        try {
            body += buildCustomerXml(ctpCustomers[i]);
            built++;
        } catch (e) {
            failed++;
            if (errors.length < 5) {
                errors.push((ctpCustomers[i].email || ctpCustomers[i].id) + ': ' + (e.message || String(e)));
            }
        }
    }

    return { body: body, built: built, failed: failed, errors: errors };
}

/**
 * Build SFCC customer import XML for a batch of CT customer objects.
 * @param {Array} ctpCustomers - raw CT customer objects from ctpCustomerFetcher
 * @returns {{ xml: string, built: number, failed: number, errors: Array }}
 */
function buildXml(ctpCustomers) {
    var fragment = buildCustomerFragment(ctpCustomers);
    return {
        xml:    XML_HEADER + fragment.body + XML_FOOTER,
        built:  fragment.built,
        failed: fragment.failed,
        errors: fragment.errors
    };
}

module.exports = {
    buildXml:              buildXml,
    buildCustomerFragment: buildCustomerFragment,
    buildAddressXml:       buildAddressXml,
    buildProfileXml:       buildProfileXml,
    xmlEsc:                xmlEsc,
    XML_HEADER:            XML_HEADER,
    XML_FOOTER:            XML_FOOTER
};
