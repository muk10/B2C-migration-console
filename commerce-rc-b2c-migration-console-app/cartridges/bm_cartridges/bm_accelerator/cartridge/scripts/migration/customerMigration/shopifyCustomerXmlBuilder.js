'use strict';

var transformer      = require('*/cartridge/scripts/migration/customerMigration/shopifyCustomerTransformer');
var ctpXmlBuilder    = require('*/cartridge/scripts/migration/customerMigration/customerXmlBuilder');
var groupFetcher     = require('*/cartridge/scripts/migration/customerMigration/shopifyCustomerGroupFetcher');

var xmlEsc          = ctpXmlBuilder.xmlEsc;
var buildAddressXml = ctpXmlBuilder.buildAddressXml;
var XML_HEADER      = ctpXmlBuilder.XML_HEADER;
var XML_FOOTER      = ctpXmlBuilder.XML_FOOTER;

function buildCustomerXml(shopifyCustomer) {
    var transformed = transformer.transformCustomer(shopifyCustomer);
    var profile      = transformed.profile;
    var addresses    = transformed.addresses;

    var shopifyId  = String(shopifyCustomer.id);
    var customerNo = shopifyId;
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

    // Shopify has no direct customer-group concept — one SFCC group per tag instead.
    if (profile.c_shopify_tags && profile.c_shopify_tags.length) {
        xml += '        <customer-groups>\n';
        for (var g = 0; g < profile.c_shopify_tags.length; g++) {
            xml += '            <customer-group group-id="' + xmlEsc(groupFetcher.groupIdForTag(profile.c_shopify_tags[g])) + '"/>\n';
        }
        xml += '        </customer-groups>\n';
    }

    xml += '    </customer>\n';
    return xml;
}

/**
 * Build just the <customer> element(s) for a batch — no XML header/root wrapper.
 * @param {Array} shopifyCustomers - raw Shopify customer objects
 * @returns {{ body: string, built: number, failed: number, errors: Array }}
 */
function buildCustomerFragment(shopifyCustomers) {
    var built  = 0;
    var failed = 0;
    var errors = [];
    var body   = '';

    for (var i = 0; i < shopifyCustomers.length; i++) {
        try {
            body += buildCustomerXml(shopifyCustomers[i]);
            built++;
        } catch (e) {
            failed++;
            if (errors.length < 5) {
                errors.push((shopifyCustomers[i].email || shopifyCustomers[i].id) + ': ' + (e.message || String(e)));
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
