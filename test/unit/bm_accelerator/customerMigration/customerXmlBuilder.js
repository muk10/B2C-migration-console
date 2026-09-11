'use strict';

/* eslint-env mocha */

var assert = require('chai').assert;
var path = require('path');
var proxyquire = require('proxyquire').noCallThru();

var systemProfilePath = path.join(
    __dirname,
    '../../../../commerce-rc-b2c-migration-console-app/cartridges/bm_cartridges/bm_accelerator/cartridge/scripts/migration/customerMigration/customerSystemProfile.js'
);
var customerSystem = require(systemProfilePath);

function loadBuilder(transformFn) {
    return proxyquire(
        path.join(
            __dirname,
            '../../../../commerce-rc-b2c-migration-console-app/cartridges/bm_cartridges/bm_accelerator/cartridge/scripts/migration/customerMigration/customerXmlBuilder.js'
        ),
        {
            '*/cartridge/scripts/migration/customerMigration/customerTransformer': {
                transformCustomer: transformFn || function (ctpCustomer) {
                    return {
                        profile: {
                            email: ctpCustomer.email,
                            login: ctpCustomer.email,
                            first_name: ctpCustomer.firstName,
                            last_name: ctpCustomer.lastName,
                            company_name: ctpCustomer.companyName,
                            tax_id: ctpCustomer.vatId,
                            birthday: ctpCustomer.dateOfBirth,
                            preferred_locale: 'en_GB'
                        },
                        addresses: ctpCustomer.addresses || []
                    };
                }
            },
            '*/cartridge/scripts/migration/customerMigration/customerSystemProfile': customerSystem,
            '*/cartridge/scripts/migration/core/tempPassword': {
                generate: function () { return 'Temp#Pass1'; }
            }
        }
    );
}

var xmlBuilder = loadBuilder();

describe('customer XML profile schema', function () {
    it('emits company-name before email, matching the customer.xsd sequence', function () {
        var result = xmlBuilder.buildXml([{
            id: 'cust-1',
            email: 'a@example.com',
            firstName: 'Ann',
            lastName: 'Lee',
            companyName: 'Acme Ltd',
            vatId: 'GB123',
            dateOfBirth: '1990-01-02T00:00:00.000Z',
            addresses: []
        }]);
        assert.match(result.xml, /<last-name>Lee<\/last-name>\s*<company-name>Acme Ltd<\/company-name>\s*<email>a@example.com<\/email>/);
        assert.notMatch(result.xml, /<email>[\s\S]*<company-name>/);
        assert.notMatch(result.xml, /<profile>[\s\S]*<tax-id>/);
        assert.notMatch(result.xml, /custom-attribute attribute-id="taxID"/);
        assert.match(result.xml, /<email>a@example.com<\/email>\s*<birthday>1990-01-02<\/birthday>/);
    });

    it('writes address fields in customer.xsd order with postbox not post-box', function () {
        var xml = xmlBuilder.buildAddressXml({
            address_id: 'addr-1',
            preferred: true,
            last_name: 'Lee',
            company_name: 'Acme Ltd',
            address1: '1 High St',
            suite: '4B',
            post_box: 'PO 12',
            city: 'London',
            postal_code: 'SW1A 1AA',
            country_code: 'GB'
        });
        assert.match(xml, /<last-name>Lee<\/last-name>\s*<company-name>Acme Ltd<\/company-name>\s*<address1>/);
        assert.match(xml, /<address1>1 High St<\/address1>\s*<suite>4B<\/suite>\s*<postbox>PO 12<\/postbox>\s*<city>London<\/city>/);
        assert.notMatch(xml, /<post-box>/);
        assert.notMatch(xml, /<city>[\s\S]*<suite>/);
    });

    it('does not write taxID as a custom-attribute (OOTB, no profile XSD tag)', function () {
        var builder = loadBuilder(function (ctpCustomer) {
            return {
                profile: {
                    email: ctpCustomer.email,
                    login: ctpCustomer.email,
                    tax_id: 'GB123',
                    c_taxID: 'GB123'
                },
                addresses: []
            };
        });
        var result = builder.buildXml([{ id: 'c1', email: 'a@example.com' }]);
        assert.notMatch(result.xml, /custom-attribute attribute-id="taxID"/);
        assert.notMatch(result.xml, /<tax-id>/);
    });

    it('writes phoneMobile as profile phone-mobile, not a custom-attribute', function () {
        var builder = loadBuilder(function (ctpCustomer) {
            return {
                profile: {
                    email: ctpCustomer.email,
                    login: ctpCustomer.email,
                    first_name: 'Ann',
                    last_name: 'Lee',
                    c_phoneMobile: '07700900123'
                },
                addresses: []
            };
        });
        var result = builder.buildXml([{ id: 'c1', email: 'a@example.com' }]);
        assert.match(result.xml, /<phone-mobile>07700900123<\/phone-mobile>/);
        assert.notMatch(result.xml, /custom-attribute attribute-id="phoneMobile"/);
    });

    it('formats datetime custom attributes without a trailing Z', function () {
        var builder = loadBuilder(function (ctpCustomer) {
            return {
                profile: {
                    email: ctpCustomer.email,
                    login: ctpCustomer.email,
                    c_externalImportDate: '2023-02-17T14:15:32.288Z'
                },
                addresses: []
            };
        });
        var result = builder.buildXml([{ id: 'c1', email: 'a@example.com' }]);
        assert.match(result.xml, /custom-attribute attribute-id="externalImportDate">2023-02-17T14:15:32.288\+0000/);
        assert.notMatch(result.xml, /externalImportDate">2023-02-17T14:15:32.288Z/);
    });

    it('maps a source field to an OOTB profile element at write time', function () {
        var xml = xmlBuilder.buildProfileXml({
            email: 'a@example.com',
            c_cell: '07700900123'
        }, { cell: 'phoneMobile' });
        assert.match(xml, /<phone-mobile>07700900123<\/phone-mobile>/);
        assert.notMatch(xml, /custom-attribute attribute-id="cell"/);
        assert.notMatch(xml, /custom-attribute attribute-id="phoneMobile"/);
    });

    it('maps a source field to a custom attribute id at write time', function () {
        var xml = xmlBuilder.buildProfileXml({
            email: 'a@example.com',
            c_loyaltyTier: 'gold'
        }, { loyaltyTier: 'vip_tier' });
        assert.match(xml, /custom-attribute attribute-id="vip_tier">gold/);
        assert.notMatch(xml, /custom-attribute attribute-id="loyaltyTier"/);
    });

    it('keeps identity mapping when the source id is already an OOTB field', function () {
        var mapped = customerSystem.applyRuntimeMaps({
            c_phoneMobile: '07700900123'
        }, {});
        assert.equal(mapped.system.phone_mobile, '07700900123');
        assert.equal(mapped.custom.length, 0);
    });

    it('formats mapped datetime custom values without a trailing Z', function () {
        var mapped = customerSystem.applyRuntimeMaps({
            c_importedAt: '2023-02-17T14:15:32.288Z'
        }, { importedAt: 'externalImportDate' });
        assert.equal(mapped.custom[0].id, 'externalImportDate');
        assert.equal(mapped.custom[0].value, '2023-02-17T14:15:32.288Z');
        assert.equal(
            customerSystem.formatCustomAttrValue(mapped.custom[0].value),
            '2023-02-17T14:15:32.288+0000'
        );
    });

    it('emits preferred-locale after last-visit-time when both are present', function () {
        var xml = xmlBuilder.buildProfileXml({
            email: 'a@example.com',
            last_visit_time: '2023-02-17T14:15:32.288Z',
            preferred_locale: 'en_GB'
        }, {});
        assert.match(xml, /<last-visit-time>2023-02-17T14:15:32.288\+0000<\/last-visit-time>\s*<preferred-locale>en_GB<\/preferred-locale>/);
        assert.notMatch(xml, /<preferred-locale>[\s\S]*<last-visit-time>/);
    });
});
