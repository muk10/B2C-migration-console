'use strict';

var transformer      = require('*/cartridge/scripts/migration/customerMigration/bcCustomerTransformer');
var ctpXmlBuilder    = require('*/cartridge/scripts/migration/customerMigration/customerXmlBuilder');
var groupFetcher     = require('*/cartridge/scripts/migration/customerMigration/bcCustomerGroupFetcher');

var xmlEsc          = ctpXmlBuilder.xmlEsc;
var buildAddressXml = ctpXmlBuilder.buildAddressXml;
var XML_HEADER      = ctpXmlBuilder.XML_HEADER;
var XML_FOOTER      = ctpXmlBuilder.XML_FOOTER;

function buildCustomerXml(bcCustomer) {
    var transformed = transformer.transformCustomer(bcCustomer);
    var profile      = transformed.profile;
    var addresses    = transformed.addresses;

    var bcId       = String(bcCustomer.id);
    var customerNo = bcId;
    var password   = require('*/cartridge/scripts/migration/core/tempPassword').generate();
    var login      = xmlEsc(profile.login || profile.email);

    var xml = '    <customer customer-no="' + xmlEsc(customerNo) + '">\n';

    xml += '        <credentials>\n';
    xml += '            <login>' + login + '</login>\n';
    xml += '            <password encrypted="false">' + xmlEsc(password) + '</password>\n';
    xml += '        </credentials>\n';

    xml += ctpXmlBuilder.buildProfileXml(profile);

    if (addresses.length > 0) {
        xml += '        <addresses>\n';
        for (var a = 0; a < addresses.length; a++) {
            xml += buildAddressXml(addresses[a]);
        }
        xml += '        </addresses>\n';
    }

    if (profile.c_bc_customer_group_id) {
        xml += '        <customer-groups>\n';
        xml += '            <customer-group group-id="'
            + xmlEsc(groupFetcher.groupIdForBcGroup(profile.c_bc_customer_group_id))
            + '"/>\n';
        xml += '        </customer-groups>\n';
    }

    xml += '    </customer>\n';
    return xml;
}

/**
 * Build just the <customer> element(s) for a batch — no XML header/root wrapper.
 * @param {Array} bcCustomers - raw BigCommerce customer objects
 * @returns {{ body: string, built: number, failed: number, errors: Array }}
 */
function buildCustomerFragment(bcCustomers) {
    var built  = 0;
    var failed = 0;
    var errors = [];
    var body   = '';

    for (var i = 0; i < bcCustomers.length; i++) {
        try {
            body += buildCustomerXml(bcCustomers[i]);
            built++;
        } catch (e) {
            failed++;
            if (errors.length < 5) {
                errors.push((bcCustomers[i].email || bcCustomers[i].id) + ': ' + (e.message || String(e)));
            }
        }
    }

    return { body: body, built: built, failed: failed, errors: errors };
}

module.exports = {
    buildCustomerFragment: buildCustomerFragment,
    XML_HEADER:            XML_HEADER,
    XML_FOOTER:            XML_FOOTER
};
