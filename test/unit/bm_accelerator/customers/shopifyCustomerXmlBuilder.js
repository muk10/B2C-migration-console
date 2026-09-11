'use strict';

/* eslint-env mocha */

var assert = require('chai').assert;
var path = require('path');
var proxyquire = require('proxyquire').noCallThru();

var builderPath = path.join(
    __dirname,
    '../../../../commerce-rc-b2c-migration-console-app/cartridges/bm_cartridges/bm_accelerator/cartridge/scripts/migration/customerMigration/shopifyCustomerXmlBuilder.js'
);

describe('shopifyCustomerXmlBuilder', function () {
    it('writes native and custom Profile fields into customer XML', function () {
        var builder = proxyquire(builderPath, {
            '*/cartridge/scripts/migration/customerMigration/shopifyCustomerTransformer': {
                transformCustomer: function () {
                    return {
                        profile: {
                            email: 'customer@example.com',
                            login: 'customer@example.com',
                            preferred_locale: 'en_US',
                            source_customer_id: '123',
                            c_spy_migration__loyalty_id: '42 & more',
                            shopify_tags: ['vip', 'wholesale']
                        },
                        addresses: []
                    };
                }
            },
            '*/cartridge/scripts/migration/customerMigration/customerXmlBuilder': {
                xmlEsc: function (value) {
                    return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
                },
                buildAddressXml: function () { return ''; },
                XML_HEADER: '<customers>\n',
                XML_FOOTER: '</customers>\n'
            },
            '*/cartridge/scripts/migration/customerMigration/shopifyCustomerGroupFetcher': {
                groupIdForTag: function (tag) { return tag; }
            },
            '*/cartridge/scripts/migration/core/tempPassword': {
                generate: function () { return 'temporary'; }
            }
        });

        var result = builder.buildCustomerFragment([{ id: 123, email: 'customer@example.com' }]);

        assert.equal(result.built, 1);
        assert.include(result.body, '<preferred-locale>en_US</preferred-locale>');
        assert.notInclude(result.body, '<custom-attribute attribute-id="shopify_customer_id">');
        assert.include(result.body, '<custom-attribute attribute-id="spy_migration__loyalty_id">42 &amp; more</custom-attribute>');
        assert.notInclude(result.body, '<custom-attribute attribute-id="shopify_tags">');
    });
});
